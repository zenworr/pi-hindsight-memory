import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../common/types.js";
import { Logger, errorMessage } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { scan } from "./scanner.js";
import { DaemonLock } from "./lock.js";
import { sleep } from "./scheduler.js";
import { StateDatabase } from "./state-db.js";
import { ImportWorker } from "./worker.js";

export interface DaemonOptions { once?: boolean; maxMs?: number; scanFirst?: boolean; }

export async function runImportCycle(config: AppConfig, state: StateDatabase, client: HindsightClient, logger = new Logger("importer")): Promise<{ scan: Awaited<ReturnType<typeof scan>>; worker: Awaited<ReturnType<ImportWorker["runOnce"]>> }> {
  const worker = new ImportWorker(config, state, client, logger);
  await worker.preflight();
  const scanResult = await scan(config, state);
  const workerResult = await worker.runOnce(Math.max(1000, config.maxInflightDocuments * 100));
  logger.info("Import cycle complete", { discovered: scanResult.discovered, queued: scanResult.queued, unchanged: scanResult.unchanged, completed: workerResult.completed, failed: workerResult.failed, deferred: workerResult.deferred });
  return { scan: scanResult, worker: workerResult };
}

export async function runDaemon(config: AppConfig, options: DaemonOptions = {}): Promise<void> {
  const logger = new Logger("importer-daemon");
  const lock = new DaemonLock(path.join(config.stateDirectory, "daemon.lock"));
  lock.acquire();
  const state = new StateDatabase(config.stateDatabase);
  const client = new HindsightClient(config.hindsight);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (options.once) {
      if (options.scanFirst === false) await new ImportWorker(config, state, client, logger).runOnce(Math.max(1000, config.maxInflightDocuments * 100));
      else await runImportCycle(config, state, client, logger);
      return;
    }
    let nextFullScan = 0;
    let previousDirtySignature = "";
    while (!abort.signal.aborted) {
      const paused = await isPaused(config);
      const dirty = paused ? "" : await dirtySignature(config.dirtyDirectory);
      const shouldRun = !paused && (Date.now() >= nextFullScan || dirty !== previousDirtySignature);
      if (shouldRun) {
        try { await runImportCycle(config, state, client, logger); }
        catch (error) { logger.error("Import cycle failed", { error: errorMessage(error) }); }
        nextFullScan = Date.now() + config.scanIntervalSeconds * 1000;
        previousDirtySignature = await dirtySignature(config.dirtyDirectory);
      } else if (!paused && state.pendingWorkCount() > 0) {
        try {
          const worker = new ImportWorker(config, state, client, logger);
          await worker.runOnce(Math.max(1000, config.maxInflightDocuments * 100));
        } catch (error) { logger.error("Queued import failed", { error: errorMessage(error) }); }
      }
      try { await sleep(Math.min(1000, Math.max(100, nextFullScan - Date.now())), abort.signal); } catch { break; }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    state.close();
    lock.release();
  }
}

export async function drainImporter(config: AppConfig, maxMs?: number, scanFirst = true): Promise<void> {
  const logger = new Logger("importer-drain");
  const lock = new DaemonLock(path.join(config.stateDirectory, "daemon.lock"));
  lock.acquire();
  const state = new StateDatabase(config.stateDatabase);
  const client = new HindsightClient(config.hindsight);
  try {
    const worker = new ImportWorker(config, state, client, logger, true);
    await worker.preflight();
    if (scanFirst) await scan(config, state);
    const result = await worker.drain(maxMs ?? config.hindsight.operationPollTimeoutMs);
    logger.info("Importer drained", { ...result });
  } finally { state.close(); lock.release(); }
}

export function status(config: AppConfig): Record<string, unknown> {
  const state = new StateDatabase(config.stateDatabase);
  try { return { database: config.stateDatabase, bank: config.hindsight.bankId, counts: state.counts(), budget: state.budget(), pendingWork: state.pendingWorkCount(), generations: state.listGenerations().reduce((out, generation) => { out[generation.state] = (out[generation.state] ?? 0) + 1; return out; }, {} as Record<string, number>) }; }
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

async function dirtySignature(directory: string): Promise<string> {
  const values: string[] = [];
  for (const source of ["pi", "codex", "claude", "opencode"]) {
    const child = path.join(directory, source);
    try {
      const entries = await fs.readdir(child, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
        const stat = await fs.stat(path.join(child, entry.name));
        values.push(`${source}/${entry.name}:${stat.size}:${stat.mtimeMs}`);
      }
    } catch { /* missing marker directory is normal */ }
  }
  return values.join("|");
}
