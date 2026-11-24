import fs from "node:fs/promises";
import { createAdapters } from "../adapters/index.js";
import { documentIdFor, sha256 } from "../common/hashing.js";
import type { AppConfig, SessionClassification, Source } from "../common/types.js";
import { HindsightHttpError } from "../hindsight/client.js";
import type { HindsightClient, HindsightDocument } from "../hindsight/client.js";
import { HTTP_STATUS } from "../hindsight/http.js";
import { configuredExclusion, normalizeSessionLabel } from "./exclusions.js";
import { effectiveReference, ownsLocator, selectSourceOwners, sourceRoot } from "./scanner.js";
import type { Discovered } from "./scanner.js";
import { StateDatabase } from "./state-db.js";
import type { CleanupJobRecord, GenerationRecord, SessionStateRecord } from "./state-db.js";

interface CleanupGeneration {
  jobId: string;
  canonicalHash: string;
  operationId: string;
  state: GenerationRecord["state"];
  submittedAt?: string;
  phase?: CleanupJobRecord["phase"];
}

export interface CleanupPlanJob {
  jobId: string;
  targetKind: "subagent" | "ambiguous" | "configured-exclusion";
  reason: string;
  policyVersion: string;
  label?: string;
  source: Source;
  nativeSessionId: string;
  sourceNativeSessionId: string;
  documentId: string;
  origin: string;
  locator: string;
  storedOrigin?: string;
  storedLocator: string;
  acknowledgedHash?: string;
  generations: CleanupGeneration[];
  operations: Array<{ operationId: string; canonicalHash: string; localStatus?: string; status: string; localOnly: boolean }>;
  remoteDocumentPresent: boolean;
  remoteContentHash?: string;
}

export interface CleanupPlan {
  config: { apiUrl: string; bankId: string; bankEndpoint: string; exactLabels: string[]; includeAmbiguous: boolean };
  artifacts: { total: number; primary: number; subagents: number; configured: number; ambiguous: number };
  generations: { total: number; completed: number; queued: number; submitted: number; processing: number; other: number };
  jobs: CleanupPlanJob[];
  blocked: Array<{ source: Source; nativeSessionId: string; reason: string }>;
  remoteDocumentCount: number;
  planHash: string;
}

function key(source: Source, nativeSessionId: string): string { return `${source}\n${nativeSessionId}`; }
const TERMINAL = new Set(["completed", "failed", "cancelled", "error"]);
const LOCAL_ONLY = new Set(["prepared", "ready", "rejected", "not_submitted"]);

async function available(root: string): Promise<boolean> {
  try { await fs.access(root); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function discover(config: AppConfig, state: StateDatabase, source?: Source) {
  const feed = config.desktopFeed.enabled ? await fs.realpath(config.desktopFeed.directory) : undefined;
  const adapters = createAdapters(config).filter((adapter) => !source || adapter.source === source);
  const references: Discovered[] = [];
  for (const adapter of adapters) {
    const origin = adapter.origin ?? config.localOrigin;
    const root = sourceRoot(adapter, config);
    const present = await available(root);
    if (present) {
      for await (const reference of adapter.discover({ requireRoot: true })) references.push({ adapter, reference });
    }
    if (present !== await available(root)) throw new Error(`Cleanup source availability changed: ${adapter.source} on ${origin}`);
  }
  const owners = new Map<string, Array<{ item: Discovered; classification: SessionClassification }>>();
  const artifacts: CleanupPlan["artifacts"] = { total: 0, primary: 0, subagents: 0, configured: 0, ambiguous: 0 };
  for (const item of selectSourceOwners(config, references, source)) {
    const { adapter, reference } = item;
    const structural = reference.classification ?? await adapter.classify(reference);
    const classification = configuredExclusion(reference.sessionLabel ?? reference.metadata.title ?? structural.label, config.sessionExclusions) ?? structural;
    const id = key(adapter.source, effectiveReference(state, reference).nativeSessionId);
    const group = owners.get(id) ?? [];
    group.push({ item, classification });
    owners.set(id, group);
    artifacts.total += 1;
    artifacts[classification.kind === "subagent" ? "subagents" : classification.kind === "configured-exclusion" ? "configured" : classification.kind] += 1;
  }
  if (feed !== undefined && feed !== await fs.realpath(config.desktopFeed.directory)) throw new Error("Desktop feed changed during cleanup review; retry with a stable feed");
  return { owners, adapters, artifacts };
}

type Discovery = Awaited<ReturnType<typeof discover>>;
type JobTarget = Omit<CleanupPlanJob, "remoteDocumentPresent" | "remoteContentHash">;

async function operationStatus(client: HindsightClient, operationId: string, localStatus?: string): Promise<string> {
  if (localStatus && (LOCAL_ONLY.has(localStatus) || TERMINAL.has(localStatus))) return localStatus;
  try {
    const operation = await client.getOperation(operationId);
    const id = operation.operation_id ?? operation.id;
    return id !== undefined && id !== operationId ? "unknown" : operation.status?.toLowerCase() ?? "unknown";
  } catch (error) {
    if (error instanceof HindsightHttpError && error.status === HTTP_STATUS.NOT_FOUND) return "unknown";
    throw error;
  }
}

async function buildTarget(config: AppConfig, state: StateDatabase, client: HindsightClient, discovered: Discovery, session: SessionStateRecord, generations: GenerationRecord[], previousJobs: CleanupJobRecord[], includeAmbiguous: boolean): Promise<JobTarget | string | undefined> {
  const { source, nativeSessionId, documentId } = session;
  if (session.status === "ambiguous_preserved" || !generations.length) return undefined;
  const group = discovered.owners.get(key(source, nativeSessionId));
  if (!group?.length || session.status === "source_missing") return "source-missing";
  if (group.length !== 1) return "conflicting-source-owners";
  const { item: { adapter, reference }, classification: live } = group[0]!;
  const origin = adapter.origin ?? config.localOrigin;
  const locator = reference.locator;
  const oldOwners = discovered.adapters.filter((other) => other.source === source && (ownsLocator(other, config, session.sourceLocator) || source === "opencode" && session.sourceLocator === (other.locatorRoot ?? sourceRoot(other, config))));
  const newOwners = discovered.adapters.filter((other) => other.source === source && ownsLocator(other, config, locator));
  const oldOwner = oldOwners.length === 1 ? oldOwners[0] : undefined;
  const promotion = oldOwner?.origin === "desktop" && origin === config.localOrigin && config.promotedSessions[source].includes(reference.nativeSessionId);
  const sameLocator = locator === session.sourceLocator || source === "opencode" && locator === `${session.sourceLocator}#${reference.nativeSessionId}`;
  if (documentId !== documentIdFor(source, nativeSessionId) || newOwners.length !== 1 || newOwners[0] !== adapter || !oldOwner || (oldOwner.origin ?? config.localOrigin) !== session.sourceOrigin || !promotion && (oldOwner !== adapter || !sameLocator)) return "source-owner-changed";
  const tombstone = state.getExclusionTombstone(source, reference.nativeSessionId, documentIdFor(source, reference.nativeSessionId));
  if (tombstone && tombstone.locator !== locator && (!promotion || tombstone.locator !== session.sourceLocator)) return "conflicting-exclusion";
  const classification = live.kind !== "configured-exclusion" && tombstone
    ? { kind: "configured-exclusion" as const, reason: `persisted-configured-exclusion:${tombstone.label}`, label: tombstone.label, policyVersion: live.policyVersion }
    : live;
  const { kind: targetKind, reason, policyVersion, label } = classification;
  if (targetKind === "primary" || targetKind === "ambiguous" && !includeAmbiguous) return undefined;
  const jobId = sha256(JSON.stringify(["cleanup-document-v2", client.bankEndpoint, documentId, origin, locator, targetKind]));
  const versions = generations.map((generation) => {
    const id = sha256(JSON.stringify([jobId, generation.canonicalHash, generation.operationId]));
    return { jobId: id, canonicalHash: generation.canonicalHash, operationId: generation.operationId, state: generation.state, submittedAt: generation.submittedAt, phase: previousJobs.find((job) => job.jobId === id)?.phase };
  }).sort((a, b) => a.jobId.localeCompare(b.jobId));
  for (const job of previousJobs) {
    if (job.phase === "state_finalized" && !versions.some((version) => version.jobId === job.jobId)) continue;
    const version = versions.find((value) => value.jobId === job.jobId);
    if (!version || job.action !== "delete-document" || job.targetKind !== targetKind || job.documentId !== documentId || job.source !== source || job.nativeSessionId !== nativeSessionId || job.canonicalHash !== version.canonicalHash || job.newOperationId !== undefined || job.oldOperationId !== version.operationId || job.phase === "state_finalized") return "conflicting-cleanup-job";
  }
  const storedOperations = state.db.prepare("SELECT operation_id FROM operations WHERE document_id=? ORDER BY operation_id").all(documentId) as { operation_id: string }[];
  const ids = new Set([...versions.map((version) => version.operationId), ...storedOperations.map((row) => row.operation_id)]);
  const operations: CleanupPlanJob["operations"] = [];
  for (const operationId of [...ids].sort()) {
    const stored = state.getOperation(operationId);
    const version = versions.find((item) => item.operationId === operationId);
    if (!stored) {
      if (version?.state === "submitted" || version?.submittedAt && version.state !== "completed") return "unresolved-operation";
      continue;
    }
    if (stored.documentId !== documentId || version && stored.canonicalHash !== version.canonicalHash) return "conflicting-operation";
    const status = await operationStatus(client, operationId, stored.hindsightStatus);
    const knownLocalOnly = status === stored.hindsightStatus && LOCAL_ONLY.has(status) && (status === "rejected" || !stored.submittedAt && !version?.submittedAt);
    if (!TERMINAL.has(status) && !knownLocalOnly) return "unresolved-operation";
    operations.push({ operationId, canonicalHash: stored.canonicalHash, localStatus: stored.hindsightStatus, status, localOnly: knownLocalOnly });
  }
  return { jobId, targetKind, reason, policyVersion, label, source, nativeSessionId, sourceNativeSessionId: reference.nativeSessionId, documentId, origin, locator, storedOrigin: session.sourceOrigin, storedLocator: session.sourceLocator, acknowledgedHash: session.acknowledgedHash, generations: versions, operations };
}

function targetDocument(target: JobTarget, document: HindsightDocument | undefined): CleanupPlanJob | string {
  if (!document) return { ...target, remoteDocumentPresent: false };
  if (target.generations.some((generation) => generation.phase === "remote_deleted")) return "conflicting-cleanup-job";
  if (document.id !== target.documentId || typeof document.content_hash !== "string" || !document.content_hash || document.content_hash !== target.acknowledgedHash && !target.operations.some((operation) => operation.status === "completed" && operation.canonicalHash === document.content_hash)) return "unexpected-remote-generation";
  return { ...target, remoteDocumentPresent: true, remoteContentHash: document.content_hash };
}

function relevant(generation: GenerationRecord): boolean { return generation.state !== "excluded" && generation.state !== "superseded"; }
function jobsFor(previous: CleanupJobRecord[], session: SessionStateRecord): CleanupJobRecord[] {
  return previous.filter((job) => job.documentId === session.documentId || job.source === session.source && job.nativeSessionId === session.nativeSessionId);
}

export async function revalidateCleanupJob(config: AppConfig, state: StateDatabase, client: HindsightClient, job: CleanupPlanJob, includeAmbiguous: boolean): Promise<void> {
  const discovered = await discover(config, state, job.source);
  const session = state.getSession(job.source, job.nativeSessionId);
  const generations = state.listGenerations().filter((generation) => generation.source === job.source && generation.nativeSessionId === job.nativeSessionId && relevant(generation));
  const target = session && await buildTarget(config, state, client, discovered, session, generations, jobsFor(state.listCleanupJobs(), session), includeAmbiguous);
  const current = target && typeof target !== "string" && targetDocument(target, await client.getDocument(job.documentId));
  if (JSON.stringify(current) !== JSON.stringify(job)) throw new Error(`Cleanup target changed after review: ${job.documentId}; make and review a new plan`);
}

export async function buildCleanupPlan(config: AppConfig, client: HindsightClient, options: { includeAmbiguous?: boolean } = {}): Promise<CleanupPlan> {
  const state = new StateDatabase(config.stateDatabase, { readOnly: true });
  try {
    const { apiUrl, bankId } = config.hindsight;
    const includeAmbiguous = options.includeAmbiguous === true;
    const binding = { apiUrl, bankId, bankEndpoint: client.bankEndpoint, exactLabels: config.sessionExclusions.exactLabels.map(normalizeSessionLabel).sort(), includeAmbiguous };
    const discovered = await discover(config, state);
    const allGenerations = state.listGenerations();
    const generations: CleanupPlan["generations"] = { total: allGenerations.length, completed: 0, queued: 0, submitted: 0, processing: 0, other: 0 };
    const groups = new Map<string, GenerationRecord[]>();
    for (const generation of allGenerations) {
      const { state: status, source, nativeSessionId } = generation;
      generations[status === "completed" || status === "queued" || status === "submitted" || status === "processing" ? status : "other"] += 1;
      if (!relevant(generation)) continue;
      const id = key(source, nativeSessionId);
      const group = groups.get(id) ?? [];
      group.push(generation);
      groups.set(id, group);
    }
    const previousJobs = state.listCleanupJobs();
    const documents = new Map<string, HindsightDocument>();
    for (const document of await client.listDocuments()) {
      if (documents.has(document.id)) throw new Error("Duplicate document ID during cleanup review; retry with an idle bank");
      documents.set(document.id, document);
    }
    const jobs: CleanupPlanJob[] = [];
    const blocked: CleanupPlan["blocked"] = [];
    for (const session of state.listSessions()) {
      const target = await buildTarget(config, state, client, discovered, session, groups.get(key(session.source, session.nativeSessionId)) ?? [], jobsFor(previousJobs, session), includeAmbiguous);
      const job = target && typeof target !== "string" ? targetDocument(target, documents.get(session.documentId)) : target;
      if (typeof job === "string") blocked.push({ source: session.source, nativeSessionId: session.nativeSessionId, reason: job });
      else if (job) jobs.push(job);
    }
    jobs.sort((a, b) => a.jobId.localeCompare(b.jobId));
    return { config: binding, artifacts: discovered.artifacts, generations, jobs, blocked, remoteDocumentCount: documents.size, planHash: sha256(JSON.stringify({ config: binding, jobs })) };
  } finally { state.close(); }
}
