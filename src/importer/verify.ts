import type { AppConfig } from "../common/types.js";
import { HindsightClient } from "../hindsight/client.js";
import { StateDatabase } from "./state-db.js";
import { importerHealth } from "./health.js";

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function verifyFullImport(config: AppConfig, client = new HindsightClient(config.hindsight), options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const state = new StateDatabase(config.stateDatabase);
  try {
    const sessions = state.listSessions();
    const generations = state.listGenerations();
    const completedKeys = new Set(generations.filter((generation) => generation.state === "completed").map((generation) => `${generation.source}:${generation.nativeSessionId}`));
    const expected = new Set(sessions.filter((session) => completedKeys.has(`${session.source}:${session.nativeSessionId}`)).map((session) => session.documentId));
    const excluded = new Set(sessions.filter((session) => session.status !== "ambiguous_preserved" && (session.classification?.kind !== "primary" || session.status.startsWith("excluded_"))).map((session) => session.documentId));
    for (const generation of generations.filter((generation) => generation.state === "excluded")) excluded.add(`agent-session:${generation.source}:${generation.nativeSessionId}`);
    const [documents, stats, bankConfig] = await Promise.all([client.listDocuments(options.signal), client.getBankStats(options.signal), client.getBankConfig(options.signal)]);
    const actual = new Set(documents.map((document) => document.id));
    const local = new Map(sessions.map((session) => [session.documentId, session]));
    const hashMismatches = documents.filter((document) => local.get(document.id)?.acknowledgedHash !== document.content_hash).map((document) => document.id);
    const importer = importerHealth(config, state.db);
    const missing = [...expected].filter((id) => !actual.has(id));
    const excludedPresent = [...excluded].filter((id) => actual.has(id));
    const unexpected = [...actual].filter((id) => !expected.has(id));
    const imported = sessions.filter((session) => session.status === "imported").length;
    const preservedAmbiguous = sessions.filter((session) => session.status === "ambiguous_preserved").length;
    const pending = state.pendingWorkCount();
    const failed = generations.filter((generation) => generation.state === "failed");
    const activeOperations = Math.max(count(stats.pending_operations), count(stats.operations_by_status?.pending) + count(stats.operations_by_status?.processing));
    const failedOperations = Math.max(count(stats.failed_operations), count(stats.operations_by_status?.failed));
    const pendingConsolidation = count(stats.pending_consolidation);
    const failedConsolidation = count(stats.failed_consolidation);
    const autoConsolidationEnabled = bankConfig.config?.enable_auto_consolidation === true;
    let bankConfigurationError: string | undefined;
    try {
      await client.assertExtractionAvailable(options.signal);
      await client.assertBankConfiguration({ requireExtraction: true, bulk: false, signal: options.signal });
    } catch (error) {
      bankConfigurationError = error instanceof Error ? error.message : String(error);
    }
    const bankConfigurationReady = bankConfigurationError === undefined;
    const sourceCoverageReady = importer.scanErrors === 0 && importer.deferred === 0 && importer.unprocessed === 0 && importer.staleSources === 0;
    const documentAccountingReady = pending === 0 && failed.length === 0 && missing.length === 0 && excludedPresent.length === 0 && unexpected.length === 0 && hashMismatches.length === 0;
    const hindsightIdle = activeOperations === 0 && failedOperations === 0 && pendingConsolidation === 0 && failedConsolidation === 0;
    const idempotencyReady = documentAccountingReady && hindsightIdle && bankConfigurationReady;
    return {
      expectedDocuments: expected.size,
      actualDocuments: actual.size,
      importedSessions: imported,
      preservedAmbiguousSessions: preservedAmbiguous,
      pendingWork: pending,
      failedGenerations: failed.length,
      missingDocuments: missing.slice(0, 100),
      missingDocumentCount: missing.length,
      excludedDocumentsPresent: excludedPresent.slice(0, 100),
      excludedDocumentsPresentCount: excludedPresent.length,
      unexpectedDocuments: unexpected.slice(0, 100),
      unexpectedDocumentCount: unexpected.length,
      activeHindsightOperations: activeOperations,
      failedHindsightOperations: failedOperations,
      pendingConsolidation,
      failedConsolidation,
      autoConsolidationEnabled,
      bankConfigurationReady,
      ...(bankConfigurationError ? { bankConfigurationError } : {}),
      documentHashMismatches: hashMismatches.slice(0, 100),
      documentHashMismatchCount: hashMismatches.length,
      importer,
      sourceCoverageReady,
      documentAccountingReady,
      hindsightIdle,
      idempotencyReady,
      activationReady: idempotencyReady && sourceCoverageReady && autoConsolidationEnabled,
      continuousReady: idempotencyReady && sourceCoverageReady && autoConsolidationEnabled && importer.running && !importer.paused && !importer.lastError,
      budget: state.budget(),
    };
  } finally { state.close(); }
}
