import type { AppConfig } from "../common/types.js";
import { Logger } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { scan } from "./scanner.js";
import { ImportWorker } from "./worker.js";
import { StateDatabase } from "./state-db.js";

export interface HistoricalImportSummary { scanned: number; queued: number; imported: number; cohorts: number; }

export async function importAll(config: AppConfig, state: StateDatabase, client: HindsightClient, options: { cohortSize?: number; maxMs?: number; logger?: Logger } = {}): Promise<HistoricalImportSummary> {
  const cohortSize = options.cohortSize ?? 250;
  const maxMs = options.maxMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isInteger(cohortSize) || cohortSize <= 0) throw new Error("cohortSize must be a positive integer");
  const logger = options.logger ?? new Logger("historical-import");
  const started = Date.now();
  const worker = new ImportWorker(config, state, client, logger, true);
  await worker.preflight();
  const summary: HistoricalImportSummary = { scanned: 0, queued: 0, imported: 0, cohorts: 0 };
  let offset = 0;
  for (;;) {
    if (Date.now() - started >= maxMs) throw new Error(`historical import exceeded ${maxMs} ms`);
    const scanResult = await scan(config, state, { offset, limit: cohortSize, force: true });
    if (scanResult.discovered === 0) break;
    summary.scanned += scanResult.discovered;
    summary.queued += scanResult.queued;
    const cohort = await worker.drain(Math.max(1, maxMs - (Date.now() - started)));
    if (cohort.failed > 0) throw new Error(`historical import stopped after ${cohort.failed} failed generation(s)`);
    if (cohort.completed > 0) {
      summary.imported += cohort.completed;
      summary.cohorts += 1;
      const consolidation = await client.consolidate();
      if (consolidation.operation_id) await client.waitForOperation(consolidation.operation_id, undefined, Math.max(1, maxMs - (Date.now() - started)));
      logger.info("Historical cohort complete", { cohort: summary.cohorts, imported: summary.imported, remaining: state.pendingWorkCount() });
    }
    offset += scanResult.discovered;
    if (scanResult.discovered < cohortSize) break;
  }
  return summary;
}
