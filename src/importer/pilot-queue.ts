import type { AppConfig, Source } from "../common/types.js";
import { ADAPTER_VERSION, CANONICAL_SCHEMA, REDACTION_POLICY_VERSION } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import { effectiveReference } from "./scanner.js";
import { queueGeneration } from "./queue.js";
import { StateDatabase } from "./state-db.js";
import type { PilotEntry } from "./pilot.js";

export interface QueuePilotSummary { selected: number; queued: number; alreadyKnown: number; errors: Array<{ source: Source; nativeSessionId: string; error: string }>; }

export async function queuePilot(config: AppConfig, state: StateDatabase, entries: PilotEntry[]): Promise<QueuePilotSummary> {
  const adapters = new Map(createAdapters(config).map((adapter) => [adapter.source, adapter]));
  const summary: QueuePilotSummary = { selected: entries.length, queued: 0, alreadyKnown: 0, errors: [] };
  for (const entry of entries) {
    const adapter = adapters.get(entry.source);
    if (!adapter) { summary.errors.push({ source: entry.source, nativeSessionId: entry.nativeSessionId, error: "no adapter" }); continue; }
    try {
      let reference;
      for await (const candidate of adapter.discover()) if (candidate.nativeSessionId === entry.nativeSessionId || candidate.locator === entry.locator) { reference = candidate; break; }
      if (!reference) throw new Error("session was not found during pilot queueing");
      reference = effectiveReference(state, reference);
      const fingerprint = await adapter.fingerprint(reference);
      const session = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
      try {
        const after = await adapter.fingerprint(reference);
        if (JSON.stringify(fingerprint) !== JSON.stringify(after)) throw new Error("source changed during pilot normalization; retry");
        state.upsertSession({ source: session.source, nativeSessionId: session.nativeSessionId, documentId: session.documentId, sourceLocator: session.sourceLocator, sourceSize: after.size, sourceMtime: after.mtimeMs, sourceFingerprint: { ...after, processing_signature: `${CANONICAL_SCHEMA}|${ADAPTER_VERSION}|${REDACTION_POLICY_VERSION}` } as any, canonicalHash: session.canonicalHash, canonicalBytes: session.canonicalBytes, canonicalTurns: session.canonicalTurns, canonicalSchema: CANONICAL_SCHEMA, sessionStartedAt: session.sessionStartedAt, sessionUpdatedAt: session.sessionUpdatedAt, status: session.emptyAfterNormalization ? "empty_after_normalization" : "discovered", lastSeenAt: new Date().toISOString() });
        state.addAlias(session.source, reference.locator, session.nativeSessionId);
        const generation = queueGeneration(state, session, config.hindsight.bankId);
        if (generation) summary.queued += 1; else summary.alreadyKnown += 1;
      } finally { await session.cleanup(); }
    } catch (error) { summary.errors.push({ source: entry.source, nativeSessionId: entry.nativeSessionId, error: error instanceof Error ? error.message : String(error) }); }
  }
  return summary;
}
