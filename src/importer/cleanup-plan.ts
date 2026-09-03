import { DatabaseSync } from "node:sqlite";
import { documentIdFor, replayOperationIdFor, sha256 } from "../common/hashing.js";
import type { AppConfig, SessionClassification, Source } from "../common/types.js";
import { HindsightClient } from "../hindsight/client.js";
import { discoverClassifications } from "./subagent-cleanup.js";
import { normalizeSessionLabel } from "./exclusions.js";

interface RawSession { source: Source; nativeSessionId: string; documentId: string; sourceLocator: string; }
interface RawGeneration { source: Source; nativeSessionId: string; canonicalHash: string; operationId: string; state: string; }
interface RawArtifact { classification: SessionClassification; }

export interface CleanupPlanJob {
  jobId: string;
  targetKind: "subagent" | "ambiguous" | "configured-exclusion" | "primary_replay";
  source: Source;
  nativeSessionId: string;
  documentId: string;
  canonicalHash: string;
  oldOperationId?: string;
  newOperationId?: string;
  state: string;
  remoteDocumentPresent: boolean;
  reason: string;
}

export interface CleanupPlan {
  config: { bankId: string; exactLabels: string[]; includeAmbiguous: boolean };
  artifacts: { total: number; primary: number; subagents: number; configured: number; ambiguous: number };
  generations: { total: number; completed: number; queued: number; submitted: number; processing: number; other: number };
  jobs: CleanupPlanJob[];
  remoteDocumentCount: number;
  planHash: string;
}

function key(source: Source, nativeSessionId: string): string { return `${source}\n${nativeSessionId}`; }
function artifactKey(source: Source, nativeSessionId: string, locator: string): string { return `${source}\n${nativeSessionId}\n${locator}`; }
function tableExists(db: DatabaseSync, name: string): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function readSessions(db: DatabaseSync): Map<string, RawSession> {
  const map = new Map<string, RawSession>();
  for (const row of db.prepare("SELECT source,native_session_id,document_id,source_locator FROM sessions").all() as Record<string, unknown>[]) {
    const source = String(row.source) as Source;
    const nativeSessionId = String(row.native_session_id);
    map.set(key(source, nativeSessionId), { source, nativeSessionId, documentId: String(row.document_id), sourceLocator: String(row.source_locator) });
  }
  return map;
}
function readArtifacts(db: DatabaseSync): Map<string, RawArtifact> {
  if (!tableExists(db, "session_artifacts")) return new Map();
  const artifacts = new Map<string, RawArtifact>();
  for (const row of db.prepare("SELECT source,native_session_id,locator,classification,classification_reason,classification_policy_version,parent_session_id FROM session_artifacts").all() as Record<string, unknown>[]) {
    const source = String(row.source) as Source;
    const nativeSessionId = String(row.native_session_id);
    const locator = String(row.locator);
    const parentSessionId = row.parent_session_id == null ? undefined : String(row.parent_session_id);
    artifacts.set(artifactKey(source, nativeSessionId, locator), {
      classification: {
        kind: String(row.classification) as SessionClassification["kind"],
        reason: String(row.classification_reason),
        policyVersion: String(row.classification_policy_version),
        ...(parentSessionId ? { parentSessionId } : {}),
      },
    });
  }
  return artifacts;
}
function readGenerations(db: DatabaseSync): RawGeneration[] {
  return (db.prepare("SELECT source,native_session_id,canonical_hash,operation_id,state FROM generations ORDER BY queued_at,source,native_session_id").all() as Record<string, unknown>[]).map((row) => ({ source: String(row.source) as Source, nativeSessionId: String(row.native_session_id), canonicalHash: String(row.canonical_hash), operationId: String(row.operation_id), state: String(row.state) }));
}
function readOperations(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT operation_id FROM operations").all() as Record<string, unknown>[]).map((row) => String(row.operation_id)));
}
function readTombstones(db: DatabaseSync): Set<string> {
  if (!tableExists(db, "exclusion_tombstones")) return new Set();
  return new Set((db.prepare("SELECT source,native_session_id,document_id FROM exclusion_tombstones").all() as Record<string, unknown>[]).map((row) => key(String(row.source) as Source, `${String(row.native_session_id)}\n${String(row.document_id)}`)));
}
function generationCounts(generations: RawGeneration[]): CleanupPlan["generations"] {
  const counts = { total: generations.length, completed: 0, queued: 0, submitted: 0, processing: 0, other: 0 };
  for (const generation of generations) {
    if (generation.state === "completed") counts.completed += 1;
    else if (generation.state === "queued") counts.queued += 1;
    else if (generation.state === "submitted") counts.submitted += 1;
    else if (generation.state === "processing") counts.processing += 1;
    else counts.other += 1;
  }
  return counts;
}
function classificationForGeneration(config: AppConfig, generation: RawGeneration, session: RawSession | undefined, groups: Map<string, { classification: SessionClassification; artifacts: Map<string, SessionClassification> }>, tombstones: Set<string>, persistedArtifacts: Map<string, RawArtifact>, includeAmbiguous: boolean): { kind: CleanupPlanJob["targetKind"]; reason: string; newOperationId?: string } | undefined {
  if (["excluded", "superseded"].includes(generation.state)) return undefined;
  const group = groups.get(key(generation.source, generation.nativeSessionId));
  const documentId = session?.documentId ?? documentIdFor(generation.source, generation.nativeSessionId);
  let classification = tombstones.has(key(generation.source, `${generation.nativeSessionId}\n${documentId}`))
    ? { kind: "configured-exclusion" as const, reason: "persisted-configured-exclusion", policyVersion: "1" }
    : group?.classification;
  if (generation.source === "claude" && group && session) {
    const artifactClassification = group.artifacts.get(session.sourceLocator);
    if (artifactClassification) classification = artifactClassification;
    else {
      const persisted = persistedArtifacts.get(artifactKey(generation.source, generation.nativeSessionId, session.sourceLocator));
      if (!persisted || persisted.classification.kind === "primary") return undefined;
      classification = persisted.classification;
    }
  }
  if (classification?.kind === "ambiguous" && !includeAmbiguous) return undefined;
  if (classification && classification.kind !== "primary") return { kind: classification.kind, reason: classification.reason };
  if (generation.state === "submitted" || generation.state === "processing") return { kind: "primary_replay", reason: "replay after clearing an interrupted primary operation", newOperationId: replayOperationIdFor(config.hindsight.bankId, documentId, generation.canonicalHash, 1) };
  return undefined;
}

export async function buildCleanupPlan(config: AppConfig, client: HindsightClient, options: { includeAmbiguous?: boolean } = {}): Promise<CleanupPlan> {
  const discovered = await discoverClassifications(config);
  const db = new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 1000 });
  try {
    const sessions = readSessions(db);
    const persistedArtifacts = readArtifacts(db);
    const generations = readGenerations(db);
    const operations = readOperations(db);
    const tombstones = readTombstones(db);
    const remoteDocuments = await client.listDocumentIds();
    const jobs: CleanupPlanJob[] = [];
    for (const generation of generations) {
      const session = sessions.get(key(generation.source, generation.nativeSessionId));
      const target = classificationForGeneration(config, generation, session, discovered.groups, tombstones, persistedArtifacts, options.includeAmbiguous === true);
      if (!target) continue;
      const documentId = session?.documentId ?? documentIdFor(generation.source, generation.nativeSessionId);
      const oldOperationId = operations.has(generation.operationId) ? generation.operationId : undefined;
      const jobId = sha256(["subagent-cleanup-v1", target.kind, generation.source, generation.nativeSessionId, generation.canonicalHash].join("\n"));
      jobs.push({ jobId, targetKind: target.kind, source: generation.source, nativeSessionId: generation.nativeSessionId, documentId, canonicalHash: generation.canonicalHash, ...(oldOperationId ? { oldOperationId } : {}), ...(target.newOperationId ? { newOperationId: target.newOperationId } : {}), state: generation.state, remoteDocumentPresent: remoteDocuments.has(documentId), reason: target.reason });
    }
    const artifacts = { total: discovered.artifacts.length, primary: discovered.artifacts.filter((item) => item.classification.kind === "primary").length, subagents: discovered.artifacts.filter((item) => item.classification.kind === "subagent").length, configured: discovered.artifacts.filter((item) => item.classification.kind === "configured-exclusion").length, ambiguous: discovered.artifacts.filter((item) => item.classification.kind === "ambiguous").length };
    const unsigned = jobs.map(({ remoteDocumentPresent: _present, ...job }) => job);
    return {
      config: { bankId: config.hindsight.bankId, exactLabels: config.sessionExclusions.exactLabels, includeAmbiguous: options.includeAmbiguous === true },
      artifacts,
      generations: generationCounts(generations),
      jobs,
      remoteDocumentCount: remoteDocuments.size,
      planHash: sha256(JSON.stringify({ bankId: config.hindsight.bankId, exactLabels: config.sessionExclusions.exactLabels.map(normalizeSessionLabel).sort(), includeAmbiguous: options.includeAmbiguous === true, jobs: unsigned })),
    };
  } finally { db.close(); }
}
