import { documentIdFor, sha256 } from "../common/hashing.js";
import type { AppConfig, SessionClassification, Source } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import { configuredExclusion } from "./exclusions.js";
import { HindsightClient, HindsightHttpError, HindsightOperationError } from "../hindsight/client.js";
import type { CleanupJobRecord, GenerationRecord, SessionArtifactRecord, StateDatabase } from "./state-db.js";

export interface ClassifiedGroup {
  classification: SessionClassification;
  count: number;
  artifacts: Map<string, SessionClassification>;
}

export interface SubagentCleanupSummary {
  artifacts: number;
  subagentArtifacts: number;
  configuredArtifacts: number;
  ambiguousArtifacts: number;
  primaryArtifacts: number;
  planned: number;
  remoteDeleted: number;
  excluded: number;
  replayed: number;
}

function nativeKey(source: Source, nativeSessionId: string): string { return `${source}\n${nativeSessionId}`; }
function artifactKey(source: Source, nativeSessionId: string, locator: string): string { return `${source}\n${nativeSessionId}\n${locator}`; }

function mergeClassification(left: SessionClassification, right: SessionClassification): SessionClassification {
  if (left.kind === right.kind) return left;
  return {
    kind: "ambiguous",
    reason: `conflicting-artifact-classifications:${left.kind}:${right.kind}`,
    policyVersion: left.policyVersion,
    ...(left.parentSessionId ?? right.parentSessionId ? { parentSessionId: left.parentSessionId ?? right.parentSessionId } : {}),
  };
}

export async function discoverClassifications(config: AppConfig): Promise<{ groups: Map<string, ClassifiedGroup>; artifacts: SessionArtifactRecord[] }> {
  const groups = new Map<string, ClassifiedGroup>();
  const artifacts: SessionArtifactRecord[] = [];
  for (const adapter of createAdapters(config)) {
    for await (const discovered of adapter.discover()) {
      const structuralClassification = discovered.classification ?? await adapter.classify(discovered);
      const label = discovered.sessionLabel ?? discovered.metadata.title ?? structuralClassification.label;
      const documentId = documentIdFor(adapter.source, discovered.nativeSessionId);
      const configured = configuredExclusion(label, config.sessionExclusions);
      const classification = configured ?? structuralClassification;
      const record: SessionArtifactRecord = {
        source: adapter.source,
        locator: discovered.locator,
        nativeSessionId: discovered.nativeSessionId,
        documentId,
        classification,
        observedAt: new Date().toISOString(),
        sessionStartedAt: discovered.sessionStartedAt,
        sessionUpdatedAt: discovered.sessionUpdatedAt,
      };
      artifacts.push(record);
      const key = nativeKey(adapter.source, discovered.nativeSessionId);
      const prior = groups.get(key);
      if (prior) {
        prior.classification = mergeClassification(prior.classification, classification);
        prior.count += 1;
        prior.artifacts.set(discovered.locator, classification);
      } else {
        groups.set(key, { classification, count: 1, artifacts: new Map([[discovered.locator, classification]]) });
      }
    }
  }
  return { groups, artifacts };
}

async function classifyLiveSources(config: AppConfig, state: StateDatabase): Promise<Map<string, ClassifiedGroup>> {
  const discovered = await discoverClassifications(config);
  for (const artifact of discovered.artifacts) {
    const configured = artifact.classification.kind === "configured-exclusion" ? artifact.classification : undefined;
    state.recordArtifact(artifact);
    if (configured?.label) state.recordExclusionTombstone({ source: artifact.source, nativeSessionId: artifact.nativeSessionId, documentId: artifact.documentId, locator: artifact.locator, label: configured.label, normalizedLabel: configured.label.normalize("NFKC").trim().toLowerCase(), createdAt: artifact.observedAt, updatedAt: artifact.observedAt });
  }
  return discovered.groups;
}

function cleanupJobId(generation: GenerationRecord, targetKind: CleanupJobRecord["targetKind"]): string {
  return sha256(["subagent-cleanup-v1", targetKind, generation.source, generation.nativeSessionId, generation.canonicalHash].join("\n"));
}

function targetForGeneration(state: StateDatabase, generation: GenerationRecord, groups: Map<string, ClassifiedGroup>, persistedArtifacts: Map<string, SessionArtifactRecord>, includeAmbiguous: boolean): { kind: "subagent" | "ambiguous" | "configured-exclusion" | "primary_replay"; reason: string; newOperationId?: string } | undefined {
  if (["excluded", "superseded"].includes(generation.state)) return undefined;
  const live = groups.get(nativeKey(generation.source, generation.nativeSessionId));
  const session = state.getSession(generation.source, generation.nativeSessionId);
  const documentId = session?.documentId ?? documentIdFor(generation.source, generation.nativeSessionId);
  const tombstone = state.getExclusionTombstone(generation.source, generation.nativeSessionId, documentId);
  const stored = session?.classification;
  let classification = tombstone ? { kind: "configured-exclusion" as const, reason: `persisted-configured-exclusion:${tombstone.label}`, policyVersion: "1", label: tombstone.label } : live?.classification ?? stored;
  if (generation.source === "claude" && live && session) {
    const artifactClassification = live.artifacts.get(session.sourceLocator);
    if (artifactClassification) classification = artifactClassification;
    else {
      const persisted = persistedArtifacts.get(artifactKey(generation.source, generation.nativeSessionId, session.sourceLocator));
      if (!persisted || persisted.classification.kind === "primary") return undefined;
      classification = persisted.classification;
    }
  }
  if (session?.status === "ambiguous_preserved" && classification?.kind !== "configured-exclusion" && !includeAmbiguous) return undefined;
  if (classification?.kind === "ambiguous" && !includeAmbiguous) return undefined;
  if (classification && classification.kind !== "primary") return { kind: classification.kind, reason: classification.reason };
  return undefined;
}

function planGenerationCleanup(state: StateDatabase, generation: GenerationRecord, target: { kind: "subagent" | "ambiguous" | "configured-exclusion" | "primary_replay"; reason: string; newOperationId?: string }): boolean {
  const session = state.getSession(generation.source, generation.nativeSessionId);
  const oldOperation = state.getOperation(generation.operationId);
  const job: CleanupJobRecord = {
    jobId: cleanupJobId(generation, target.kind),
    action: "delete-document",
    targetKind: target.kind,
    source: generation.source,
    nativeSessionId: generation.nativeSessionId,
    documentId: session?.documentId ?? documentIdFor(generation.source, generation.nativeSessionId),
    canonicalHash: generation.canonicalHash,
    ...(oldOperation ? { oldOperationId: generation.operationId } : {}),
    ...(target.newOperationId ? { newOperationId: target.newOperationId } : {}),
    phase: "planned",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (state.getCleanupJob(job.jobId)) return false;
  state.planCleanupJob(job);
  return true;
}

async function settleOperation(client: HindsightClient, operationId: string): Promise<string> {
  let operation = await client.getOperation(operationId);
  let status = String(operation.status ?? "").toLowerCase();
  if (status === "pending") {
    await client.cancelOperation(operationId);
    operation = await client.getOperation(operationId);
    status = String(operation.status ?? "").toLowerCase();
  }
  if (status === "processing" || status === "pending") {
    try { operation = await client.waitForOperation(operationId, undefined, 24 * 60 * 60 * 1000); }
    catch (error) {
      if (error instanceof HindsightOperationError) return error.status;
      throw error;
    }
    status = String(operation.status ?? "").toLowerCase();
  }
  if (!["completed", "failed", "cancelled", "error"].includes(status)) throw new Error(`Operation completion is unknown; cleanup cannot safely continue: ${operationId}`);
  return status;
}

async function deleteDocumentIdempotently(client: HindsightClient, documentId: string): Promise<void> {
  try { await client.deleteDocument(documentId); }
  catch (error) {
    if (!(error instanceof HindsightHttpError && error.status === 404)) throw error;
  }
}

export async function cleanupSubagents(config: AppConfig, state: StateDatabase, client: HindsightClient, options: { includeAmbiguous?: boolean; jobIds?: Set<string> } = {}): Promise<SubagentCleanupSummary> {
  const groups = await classifyLiveSources(config, state);
  const persistedArtifacts = new Map(state.listArtifacts().map((artifact) => [artifactKey(artifact.source, artifact.nativeSessionId, artifact.locator), artifact]));
  const summary: SubagentCleanupSummary = { artifacts: state.listArtifacts().length, subagentArtifacts: state.listArtifacts("subagent").length, configuredArtifacts: state.listArtifacts("configured-exclusion").length, ambiguousArtifacts: state.listArtifacts("ambiguous").length, primaryArtifacts: state.listArtifacts("primary").length, planned: 0, remoteDeleted: 0, excluded: 0, replayed: 0 };
  for (const generation of state.listGenerations()) {
    const target = targetForGeneration(state, generation, groups, persistedArtifacts, options.includeAmbiguous === true);
    if (target && planGenerationCleanup(state, generation, target)) summary.planned += 1;
  }

  const remoteDocuments = await client.listDocumentIds();
  for (const job of state.listCleanupJobs()) {
    if (job.phase === "state_finalized" || options.jobIds && !options.jobIds.has(job.jobId)) continue;
    if (job.phase === "planned") {
      if (job.oldOperationId) {
        const storedStatus = state.getOperation(job.oldOperationId)?.hindsightStatus;
        const localOnly = ["prepared", "ready", "rejected"].includes(storedStatus ?? "");
        const terminal = ["completed", "failed", "cancelled", "error"].includes(storedStatus ?? "");
        const status = localOnly ? "not_submitted" : terminal ? storedStatus! : await settleOperation(client, job.oldOperationId);
        state.upsertOperation({ operationId: job.oldOperationId, documentId: job.documentId, canonicalHash: job.canonicalHash ?? "", hindsightStatus: status, lastPolledAt: new Date().toISOString(), retryCount: 0, responseSummary: JSON.stringify({ cleanup: true, status }) });
      }
      if (remoteDocuments.has(job.documentId)) {
        await deleteDocumentIdempotently(client, job.documentId);
        remoteDocuments.delete(job.documentId);
      }
      state.updateCleanupJob(job.jobId, "remote_deleted");
      summary.remoteDeleted += 1;
    }
    const current = state.getCleanupJob(job.jobId) ?? job;
    if (current.phase !== "remote_deleted") continue;
    if (current.oldOperationId) state.releaseBudget(current.oldOperationId);
    if (current.targetKind === "primary_replay") {
      if (!current.canonicalHash || !current.newOperationId) throw new Error(`Primary cleanup job is missing replay data: ${current.jobId}`);
      state.requeueAfterCleanup(current.source, current.nativeSessionId, current.canonicalHash, current.newOperationId, "Requeued after deleting the interrupted retain result");
      summary.replayed += 1;
    } else {
      if (!current.canonicalHash) throw new Error(`Exclusion cleanup job is missing canonical hash: ${current.jobId}`);
      state.finalizeExcluded(current.source, current.nativeSessionId, current.canonicalHash, `Excluded ${current.targetKind} session: ${groups.get(nativeKey(current.source, current.nativeSessionId))?.classification.reason ?? "persisted classification"}`, current.targetKind);
      summary.excluded += 1;
    }
    state.updateCleanupJob(current.jobId, "state_finalized");
  }
  return summary;
}
