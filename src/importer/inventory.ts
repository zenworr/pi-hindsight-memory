import fs from "node:fs/promises";
import type { AppConfig, InventoryReport, InventorySessionResult, Source } from "../common/types.js";
import { ADAPTER_VERSION, CANONICAL_SCHEMA, REDACTION_POLICY_VERSION, SOURCES } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import type { SessionAdapter } from "../adapters/adapter.js";
import { errorMessage } from "../common/logging.js";
import { configuredExclusion } from "./exclusions.js";

function emptySourceStats() {
  return { discovered: 0, eligible: 0, empty: 0, subagents: 0, configured: 0, ambiguous: 0, malformed: 0, tooLarge: 0, errors: 0, sourceBytes: 0, canonicalBytes: 0, canonicalTurns: 0, redactions: 0 };
}

export async function runInventory(config: AppConfig, options: { source?: Source; limit?: number; includeResults?: boolean } = {}): Promise<InventoryReport> {
  const started = Date.now();
  const bySource = Object.fromEntries(SOURCES.map((source) => [source, emptySourceStats()])) as InventoryReport["bySource"];
  const results: InventorySessionResult[] = [];
  let missingIdentifiers = 0;
  let missingTimestamps = 0;
  const adapters = createAdapters(config).filter((adapter) => !options.source || adapter.source === options.source);
  let processed = 0;
  const countedDatabaseBytes = new Set<string>();
  for (const adapter of adapters) {
    const stats = bySource[adapter.source];
    try {
      for await (const reference of adapter.discover()) {
        if (options.limit !== undefined && processed >= options.limit) break;
        processed += 1;
        stats.discovered += 1;
        if (reference.nativeSessionId.startsWith("fallback-")) missingIdentifiers += 1;
        if (!reference.sessionStartedAt || reference.sessionStartedAt === "1970-01-01T00:00:00.000Z") missingTimestamps += 1;
        let sourceBytes = 0;
        const sourcePath = reference.sourcePath ?? reference.locator.split("#", 1)[0]!;
        try {
          if (adapter.source !== "opencode" || !countedDatabaseBytes.has(sourcePath)) {
            sourceBytes = (await fs.stat(sourcePath)).size;
            if (adapter.source === "opencode") countedDatabaseBytes.add(sourcePath);
          }
        } catch { /* adapter will report a useful error */ }
        const structuralClassification = reference.classification ?? await adapter.classify(reference);
        const classification = configuredExclusion(reference.sessionLabel ?? reference.metadata.title, config.sessionExclusions) ?? structuralClassification;
        if (classification.kind !== "primary") {
          if (classification.kind === "subagent") stats.subagents += 1;
          else if (classification.kind === "configured-exclusion") stats.configured += 1;
          else stats.ambiguous += 1;
          results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: classification.kind === "subagent" ? "excluded_subagent" : classification.kind === "configured-exclusion" ? "excluded_configured" : "ambiguous", sourceBytes, startedAt: reference.sessionStartedAt, updatedAt: reference.sessionUpdatedAt });
          continue;
        }
        let session;
        try {
          session = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
        } catch (error) {
          const message = errorMessage(error);
          const tooLarge = /configured limit|exceeds .* bytes/i.test(message);
          if (tooLarge) stats.tooLarge += 1; else if (/JSON|malformed|Unexpected token/i.test(message)) stats.malformed += 1; else stats.errors += 1;
          const result: InventorySessionResult = { source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: tooLarge ? "too_large" : /JSON|malformed|Unexpected token/i.test(message) ? "malformed" : "error", sourceBytes, error: message };
          results.push(result);
          continue;
        }
        try {
          const tooLarge = session.canonicalBytes > config.maxCanonicalBytes;
          if (tooLarge) stats.tooLarge += 1;
          else if (session.emptyAfterNormalization) stats.empty += 1;
          else stats.eligible += 1;
          stats.sourceBytes += sourceBytes;
          stats.canonicalBytes += session.canonicalBytes;
          stats.canonicalTurns += session.canonicalTurns;
          stats.redactions += session.redactionCount;
          results.push({ source: adapter.source, nativeSessionId: session.nativeSessionId, locator: reference.locator, status: tooLarge ? "too_large" : session.emptyAfterNormalization ? "empty_after_normalization" : "eligible", sourceBytes, canonicalBytes: session.canonicalBytes, canonicalTurns: session.canonicalTurns, redactionCount: session.redactionCount, startedAt: session.sessionStartedAt, updatedAt: session.sessionUpdatedAt });
        } finally { await session.cleanup().catch(() => undefined); }
      }
    } catch (error) {
      stats.errors += 1;
      results.push({ source: adapter.source, nativeSessionId: "<discovery>", locator: adapter.source === "opencode" ? config.opencodeDatabase : config.sourceRoots[adapter.source], status: "error", error: errorMessage(error) });
    }
  }
  const largestCanonical = results.filter((result) => result.canonicalBytes !== undefined).sort((a, b) => (b.canonicalBytes ?? 0) - (a.canonicalBytes ?? 0)).slice(0, 20).map((result) => ({ source: result.source, nativeSessionId: result.nativeSessionId, canonicalBytes: result.canonicalBytes ?? 0, sourceBytes: result.sourceBytes ?? 0 }));
  const totals = SOURCES.reduce((acc, source) => {
    const stats = bySource[source];
    acc.discovered += stats.discovered; acc.eligible += stats.eligible; acc.empty += stats.empty; acc.subagents += stats.subagents; acc.configured += stats.configured; acc.ambiguous += stats.ambiguous; acc.malformed += stats.malformed; acc.tooLarge += stats.tooLarge; acc.errors += stats.errors; acc.sourceBytes += stats.sourceBytes; acc.canonicalBytes += stats.canonicalBytes; acc.canonicalTurns += stats.canonicalTurns; acc.redactions += stats.redactions;
    return acc;
  }, { discovered: 0, eligible: 0, empty: 0, subagents: 0, configured: 0, ambiguous: 0, malformed: 0, tooLarge: 0, errors: 0, sourceBytes: 0, canonicalBytes: 0, canonicalTurns: 0, redactions: 0 });
  return { generatedAt: new Date().toISOString(), durationMs: Date.now() - started, parserVersion: ADAPTER_VERSION, canonicalSchema: CANONICAL_SCHEMA, redactionPolicyVersion: REDACTION_POLICY_VERSION, totals, bySource, largestCanonical, missingIdentifiers, missingTimestamps, ...(options.includeResults === false ? {} : { results }) };
}
