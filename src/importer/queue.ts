import type { CanonicalSession, Source } from "../common/types.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { operationIdFor, replayOperationIdFor } from "../common/hashing.js";
import type { GenerationRecord } from "./state-db.js";
import { StateDatabase } from "./state-db.js";

export function nextOperationId(state: StateDatabase, bankId: string, documentId: string, hash: string, previousId?: string): string {
  let id = operationIdFor(bankId, documentId, hash);
  for (let replay = 1; id === previousId || state.getOperation(id); replay += 1) id = replayOperationIdFor(bankId, documentId, hash, replay);
  return id;
}

export function queueGeneration(state: StateDatabase, session: CanonicalSession, bankId: string): GenerationRecord | undefined {
  if (session.emptyAfterNormalization || session.classification?.kind !== undefined && session.classification.kind !== "primary") return undefined;
  const existing = state.getGeneration(session.source, session.nativeSessionId, session.canonicalHash);
  state.supersedeOlder(session.source, session.nativeSessionId, session.canonicalHash);
  if (existing && ["submitted", "processing", "queued"].includes(existing.state)) return existing;
  const current = state.getSession(session.source, session.nativeSessionId);
  const otherWriter = state.db.prepare("SELECT 1 FROM generations WHERE source=? AND native_session_id=? AND canonical_hash<>? AND state IN ('submitted','processing') LIMIT 1").get(session.source, session.nativeSessionId, session.canonicalHash);
  if (!otherWriter && current?.acknowledgedHash === session.canonicalHash && current.acknowledgedPolicy === RETAIN_POLICY_VERSION) return undefined;
  const record: GenerationRecord = {
    source: session.source,
    nativeSessionId: session.nativeSessionId,
    canonicalHash: session.canonicalHash,
    operationId: nextOperationId(state, bankId, session.documentId, session.canonicalHash, existing?.operationId),
    state: "queued",
    queuedAt: new Date().toISOString(),
    attemptCount: existing?.state === "failed" ? existing.attemptCount : 0,
    retainPolicyVersion: RETAIN_POLICY_VERSION,
    repair: Boolean(current?.acknowledgedHash && current.acknowledgedPolicy !== RETAIN_POLICY_VERSION),
  };
  state.upsertGeneration(record);
  return record;
}

export function sourceGenerationKey(source: Source, nativeSessionId: string): string { return `${source}:${nativeSessionId}`; }
