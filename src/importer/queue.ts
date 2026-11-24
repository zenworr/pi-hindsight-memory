import type { AppConfig, CanonicalSession } from "../common/types.js";
import { Logger } from "../common/logging.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { operationIdFor, replayOperationIdFor } from "../common/hashing.js";
import type { GenerationRecord, OperationRecord, StateDatabase } from "./state-db.js";
import { UNRESOLVED_SUBMISSION } from "./state-db.js";
import { loadPendingPayload, removePendingPayload, savePendingPayload } from "./pending-payload.js";

export function nextOperationId(state: StateDatabase, bankId: string, documentId: string, hash: string, previousId?: string): string {
  let id = operationIdFor(bankId, documentId, hash);
  for (let replay = 1; id === previousId || state.getOperation(id); replay += 1) id = replayOperationIdFor(bankId, documentId, hash, replay);
  return id;
}

export async function requeueUnresolved(config: AppConfig, state: StateDatabase): Promise<number> {
  const replacements: { generation: GenerationRecord; old: OperationRecord; operationId: string; copiedPayload: boolean }[] = [];
  for (const generation of state.listGenerations()) {
    if (generation.state !== "submitted") continue;
    const old = state.getOperation(generation.operationId);
    if (old?.hindsightStatus !== UNRESOLVED_SUBMISSION) continue;
    const session = state.getSession(generation.source, generation.nativeSessionId);
    if (session?.classification?.kind !== "primary" || session.documentId !== old.documentId || old.canonicalHash !== generation.canonicalHash) {
      throw new Error("A held generation no longer matches its primary session and operation; no holds were requeued");
    }
    const operationId = nextOperationId(state, config.hindsight.bankId, old.documentId, generation.canonicalHash, old.operationId);
    const payload = await loadPendingPayload(config.spoolDirectory, old.operationId, generation.canonicalHash);
    if (payload) {
      if (payload.documentId !== old.documentId || payload.source !== generation.source || payload.nativeSessionId !== generation.nativeSessionId) throw new Error("A held payload does not belong to its generation; no holds were requeued");
      await savePendingPayload(config.spoolDirectory, operationId, payload);
    }
    replacements.push({ generation, old, operationId, copiedPayload: Boolean(payload) });
  }
  if (!replacements.length) return 0;
  state.durableTransaction(() => {
    for (const { generation, old, operationId } of replacements) {
      state.upsertOperation({ operationId, documentId: old.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: "prepared", retryCount: 0 });
      state.upsertGeneration({ ...generation, operationId, state: "queued", submittedAt: undefined, completedAt: undefined, attemptCount: 0, error: undefined });
    }
  });
  const logger = new Logger("importer-retry-unresolved");
  for (const { old, copiedPayload } of replacements) {
    if (copiedPayload) await removePendingPayload(config.spoolDirectory, old.operationId).catch(() => {
      logger.warn("Reviewed operation payload could not be removed", { operation: old.operationId });
    });
  }
  return replacements.length;
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
