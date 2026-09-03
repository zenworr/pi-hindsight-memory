import type { CanonicalSession, Source } from "../common/types.js";
import { operationIdFor } from "../common/hashing.js";
import type { GenerationRecord } from "./state-db.js";
import { StateDatabase } from "./state-db.js";

export function queueGeneration(state: StateDatabase, session: CanonicalSession, bankId: string): GenerationRecord | undefined {
  if (session.emptyAfterNormalization || session.classification?.kind !== undefined && session.classification.kind !== "primary") return undefined;
  const existing = state.getGeneration(session.source, session.nativeSessionId, session.canonicalHash);
  if (existing?.state === "completed") return undefined;
  if (existing?.state === "submitted" || existing?.state === "processing" || existing?.state === "queued") return existing;
  const operationId = operationIdFor(bankId, session.documentId, session.canonicalHash);
  const record: GenerationRecord = {
    source: session.source,
    nativeSessionId: session.nativeSessionId,
    canonicalHash: session.canonicalHash,
    operationId,
    state: "queued",
    queuedAt: new Date().toISOString(),
    attemptCount: existing?.attemptCount ?? 0,
  };
  state.upsertGeneration(record);
  state.supersedeOlder(session.source, session.nativeSessionId, session.canonicalHash);
  return record;
}

export function sourceGenerationKey(source: Source, nativeSessionId: string): string { return `${source}:${nativeSessionId}`; }
