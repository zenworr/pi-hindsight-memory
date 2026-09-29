import fs from "node:fs/promises";
import { inSpan, telemetryGauge } from "../common/telemetry.js";
import { startHealthTelemetry } from "./telemetry.js";
import path from "node:path";
import type { AppConfig } from "../common/types.js";
import { Logger, errorMessage } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { scan } from "./scanner.js";
import { withStateLock } from "./lock.js";
import { sleep } from "../common/async.js";
import { MS_PER_SECOND } from "../common/limits.js";
import { generationCounts, StateDatabase } from "./state-db.js";
import { ImportWorker } from "./worker.js";
import { verifyFullImport } from "./verify.js";
import { redactText } from "../canonical/redact.js";
import { removePendingPayload } from "./pending-payload.js";

export interface DaemonOptions { once?: boolean; scanFirst?: boolean; }

const HEARTBEAT_INTERVAL_MS = 15_000;
const DAEMON_TICK_MS = 1_000;

export async function runImportCycle(config: AppConfig, state: StateDatabase, client: HindsightClient, logger = new Logger("importer"), signal?: AbortSignal, scanFirst = true): Promise<{ scan?: Awaited<ReturnType<typeof scan>>; worker: Awaited<ReturnType<ImportWorker["runOnce"]>> }> {
  return inSpan("hindsight.import.cycle", { "hindsight.scan.enabled": scanFirst }, () => runCycle(config, state, client, logger, signal, scanFirst));
}

async function runCycle(config: AppConfig, state: StateDatabase, client: HindsightClient, logger: Logger, signal: AbortSignal | undefined, scanFirst: boolean): ReturnType<typeof runImportCycle> {
  const worker = new ImportWorker(config, state, client, logger);
  await inSpan("hindsight.import.preflight", {}, () => worker.preflight(signal));
  const scanResult = scanFirst ? await scan(config, state, { signal }) : undefined;
  const workerResult = await worker.runOnce(config.importer.workBatchSize, signal);
  if (state.pendingWorkCount(config.importer.maxAttempts) === 0 && !signal?.aborted) {
    const verification = await inSpan("hindsight.import.verify", {}, () => verifyFullImport(config, client, { signal }));
    telemetryGauge("hindsight.importer.document_accounting_ready", Number(verification.documentAccountingReady));
    telemetryGauge("hindsight.importer.document_mismatches", verification.documentHashMismatchCount);
    if (!verification.documentAccountingReady) {
      throw new Error(`Import verification failed: ${verification.failedGenerations} failed session updates, ${verification.missingDocumentCount} missing documents, ${verification.unexpectedDocumentCount} unexpected documents, ${verification.excludedDocumentsPresentCount} excluded documents present, ${verification.documentHashMismatchCount} hash mismatches; run verify-import for details`);
    }
  }
  logger.info("Import cycle complete", { discovered: scanResult?.discovered, queued: scanResult?.queued, unchanged: scanResult?.unchanged, active: scanResult?.active, completed: workerResult.completed, failed: workerResult.failed, deferred: workerResult.deferred, scanErrors: scanResult?.errors });
  return { scan: scanResult, worker: workerResult };
}

export async function runDaemon(config: AppConfig, options: DaemonOptions = {}): Promise<void> {
  await withStateLock(config, (state) => runLockedDaemon(config, state, options));
}

async function runLockedDaemon(config: AppConfig, state: StateDatabase, options: DaemonOptions): Promise<void> {
  const logger = new Logger("importer-daemon");
  try {
    for (const name of await fs.readdir(path.join(config.spoolDirectory, "pending"))) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const id = name.slice(0, -".json".length);
      if (state.getOperation(id)?.hindsightStatus === "completed") await removePendingPayload(config.spoolDirectory, id);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("Completed payload cleanup requires attention"); }
  const client = new HindsightClient(config.hindsight);
  const abort = new AbortController();
  const stop = () => { abort.abort(); };
  let phase = "starting";
  let lastError: string | undefined;
  state.heartbeat(phase);
  const stopHealthTelemetry = startHealthTelemetry(config);
  const heartbeat = setInterval(() => { state.heartbeat(phase, lastError); }, HEARTBEAT_INTERVAL_MS);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (options.once) {
      await runImportCycle(config, state, client, logger, abort.signal, options.scanFirst !== false);
      return;
    }
    let nextFullScan = 0;
    let retryAt = 0;
    while (!abort.signal.aborted) {
      const paused = await isPaused(config);
      phase = paused ? "paused" : lastError ? "error" : "idle";
      const scanDue = options.scanFirst !== false && Date.now() >= nextFullScan;
      if (!paused && Date.now() >= retryAt && (scanDue || lastError || state.pendingWorkCount(config.importer.maxAttempts) > 0)) {
        phase = "working";
        state.heartbeat(phase, lastError);
        try {
          await runImportCycle(config, state, client, logger, abort.signal, scanDue);
          if (scanDue) nextFullScan = Date.now() + config.scanIntervalSeconds * MS_PER_SECOND;
          lastError = undefined;
          phase = "idle";
          retryAt = 0;
        } catch (error) {
          if (!abort.signal.aborted) {
            lastError = redactText(errorMessage(error)).text;
            phase = "error";
            retryAt = Date.now() + config.importer.retryDelayMs;
            logger.error("Import cycle failed", { error: lastError });
          }
        }
        state.heartbeat(phase, lastError);
      }
      try { await sleep(DAEMON_TICK_MS, abort.signal); } catch { break; }
    }
  } finally {
    clearInterval(heartbeat);
    state.heartbeat("stopped");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await stopHealthTelemetry();
  }
}

export async function drainImporter(config: AppConfig, maxMs?: number, scanFirst = true): Promise<void> {
  const logger = new Logger("importer-drain");
  await withStateLock(config, async (state) => {
    const worker = new ImportWorker(config, state, new HindsightClient(config.hindsight), logger);
    if (scanFirst) { await worker.preflight(); await scan(config, state); }
    const result = await worker.drain(maxMs ?? config.hindsight.operationPollTimeoutMs);
    logger.info("Importer drained", { ...result });
    if (result.failed > 0) throw new Error("Importer drain finished with failed generations");
  });
}

export function status(config: AppConfig): Record<string, unknown> {
  const state = new StateDatabase(config.stateDatabase, { readOnly: true });
  try { return { database: config.stateDatabase, bank: config.hindsight.bankId, counts: state.counts(), budget: state.budget(), pendingWork: state.pendingWorkCount(config.importer.maxAttempts), generations: generationCounts(state.db) }; }
  finally { state.close(); }
}

export async function setPaused(config: AppConfig, paused: boolean): Promise<void> {
  await fs.mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(config.stateDirectory, "paused");
  if (paused) await fs.writeFile(target, `${new Date().toISOString()}\n`, { mode: 0o600 });
  else await fs.rm(target, { force: true });
}

async function isPaused(config: AppConfig): Promise<boolean> {
  try { await fs.access(path.join(config.stateDirectory, "paused")); return true; } catch { return false; }
}
