#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../common/config.js";
import { activeProvider, assertImportApproval, estimateCostUsd, estimateInputTokens, readApproval } from "../common/approval.js";
import { errorMessage, Logger } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { runInventory } from "./inventory.js";
import { DaemonLock } from "./lock.js";
import { drainImporter, runDaemon, setPaused, status } from "./daemon.js";
import { scan } from "./scanner.js";
import { StateDatabase } from "./state-db.js";
import { createAdapters } from "../adapters/index.js";
import type { Source } from "../common/types.js";
import { readInventory, selectPilot } from "./pilot.js";
import { queuePilot } from "./pilot-queue.js";
import { runPilot, writePilotResults } from "./pilot-runner.js";
import { importAll } from "./historical.js";
import { verifyFullImport } from "./verify.js";
import { cleanupSubagents } from "./subagent-cleanup.js";
import { buildCleanupPlan } from "./cleanup-plan.js";
import { buildRepairPlan, repairHistory, type RepairPlan } from "./repair.js";

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function has(args: string[], flag: string): boolean { return args.includes(flag); }

function sourceArg(args: string[]): Source | undefined {
  const source = value(args, "--source");
  if (!source) return undefined;
  if (!["pi", "codex", "claude", "opencode"].includes(source)) throw new Error(`Invalid source: ${source}`);
  return source as Source;
}

async function writeJson(outputPath: string | undefined, valueToWrite: unknown): Promise<void> {
  const text = `${JSON.stringify(valueToWrite, null, 2)}\n`;
  if (!outputPath || outputPath === "-") { process.stdout.write(text); return; }
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true, mode: 0o700 });
  await fs.writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
}

async function withLock<T>(config: ReturnType<typeof loadConfig>, fn: (state: StateDatabase) => Promise<T>): Promise<T> {
  const lock = new DaemonLock(path.join(config.stateDirectory, "daemon.lock"));
  lock.acquire();
  const state = new StateDatabase(config.stateDatabase);
  try { return await fn(state); } finally { state.close(); lock.release(); }
}

function usage(): void {
  process.stdout.write(`pi-hindsight-memory\n\nUsage:\n  inventory [--output FILE] [--source SOURCE] [--limit N]\n  scan [--source SOURCE] [--session-id ID] [--limit N] [--force]\n  index-evidence [--source SOURCE] [--force]\n  plan-repair [--output FILE]\n  repair --plan FILE [--max-ms N]\n  daemon [--once] [--no-scan]\n  drain [--max-ms N] [--no-scan]\n  process-queued [--max-ms N]\n  import-all [--cohort N] [--max-ms N]\n  verify-import\n  verify-ready\n  plan-cleanup [--output FILE] [--include-ambiguous]
  cleanup-subagents --apply --plan FILE\n  status\n  pause | resume\n  configure-bank [--file FILE]\n  consolidate\n  enable-auto-consolidation\n  retry-failed\n  cancel-queued\n  dry-run-extract CANONICAL_FILE [--mode concise|verbose]\n  select-pilot INVENTORY_JSON [--count N] [--max-bytes N] [--include-largest]\n  queue-pilot PILOT_JSON\n  run-pilot PILOT_JSON OUTPUT_JSON\n  export-canonical SOURCE SESSION_ID OUTPUT_FILE\n  doctor\n`);
}

async function doctor(config: ReturnType<typeof loadConfig>): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    configPath: config.configPath,
    stateDirectory: config.stateDirectory,
    sourceRoots: config.sourceRoots,
    codexStateDatabase: config.codexStateDatabase,
    opencodeDatabase: config.opencodeDatabase,
    sources: {},
    declaredProvider: activeProvider(config),
    providerIdentityVerified: false,
    approvalPresent: Boolean(readApproval(config.approvalFile)),
  };
  for (const [source, root] of Object.entries(config.sourceRoots)) {
    try { await fs.access(root); (result.sources as Record<string, unknown>)[source] = "available"; }
    catch { (result.sources as Record<string, unknown>)[source] = "missing"; }
  }
  for (const [name, pathname] of [["codexStateDatabase", config.codexStateDatabase], ["opencodeDatabase", config.opencodeDatabase]] as const) {
    try { await fs.access(pathname); result[`${name}Status`] = "available"; }
    catch { result[`${name}Status`] = "missing"; }
  }
  const client = new HindsightClient(config.hindsight);
  try {
    await client.requestJson("GET", `${config.hindsight.apiUrl.replace(/\/$/, "")}/health`);
    result.hindsight = "healthy";
  } catch (error) { result.hindsight = `unavailable: ${errorMessage(error)}`; }
  return result;
}

async function configureBank(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const manifestPath = value(args, "--file") ?? path.resolve(new URL("../../../deploy/compose/bank-config.json", import.meta.url).pathname);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const result = await withLock(config, async () => {
    const client = new HindsightClient(config.hindsight);
    await client.ensureBank();
    await client.importBankTemplate(manifest);
    await client.assertBankConfiguration();
    return client.getBankConfig();
  });
  await writeJson("-", { bank: config.hindsight.bankId, config: result });
}

async function consolidate(config: ReturnType<typeof loadConfig>): Promise<void> {
  const result = await withLock(config, async () => {
    const client = new HindsightClient(config.hindsight);
    await client.ensureBank();
    const consolidation = await client.consolidate();
    if (consolidation.operation_id) await client.waitForOperation(consolidation.operation_id);
    return consolidation;
  });
  process.stdout.write(`${JSON.stringify({ ok: true, operation_id: result.operation_id ?? null })}\n`);
}

async function importAllCommand(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const cohortSize = Number(value(args, "--cohort") ?? 250);
  const maxMs = Number(value(args, "--max-ms") ?? 24 * 60 * 60 * 1000);
  const result = await withLock(config, async (state) => importAll(config, state, new HindsightClient(config.hindsight), { cohortSize, maxMs }));
  await writeJson("-", result);
}

async function runPilotCommand(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const pilotPath = args[1];
  const outputPath = args[2];
  if (!pilotPath || !outputPath) throw new Error("run-pilot requires PILOT_JSON OUTPUT_JSON");
  const entries = JSON.parse(await fs.readFile(pilotPath, "utf8")) as import("./pilot.js").PilotEntry[];
  const approval = assertImportApproval(config);
  const estimatedTokens = entries.reduce((sum, entry) => sum + estimateInputTokens(entry.canonicalBytes) * 2, 0);
  const estimatedCost = estimateCostUsd(estimatedTokens, approval);
  if (estimatedTokens > approval.maxEstimatedInputTokens) throw new Error(`Two-mode pilot estimate ${estimatedTokens} exceeds approved input-token limit ${approval.maxEstimatedInputTokens}`);
  if (estimatedCost > approval.maxEstimatedCostUsd) throw new Error(`Two-mode pilot estimate $${estimatedCost.toFixed(4)} exceeds approved cost limit $${approval.maxEstimatedCostUsd}`);
  await writePilotResults(outputPath, await runPilot(config, entries));
  process.stdout.write(`${JSON.stringify({ output: outputPath, count: entries.length })}\n`);
}

async function queuePilotCommand(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const pilotPath = args[1];
  if (!pilotPath) throw new Error("queue-pilot requires a pilot JSON path");
  const entries = JSON.parse(await fs.readFile(pilotPath, "utf8")) as import("./pilot.js").PilotEntry[];
  const result = await withLock(config, (state) => queuePilot(config, state, entries));
  await writeJson("-", result);
}

async function selectPilotCommand(args: string[]): Promise<void> {
  const inventoryPath = args[1];
  if (!inventoryPath) throw new Error("select-pilot requires an inventory JSON path");
  const count = Number(value(args, "--count") ?? 200);
  if (!Number.isInteger(count) || count <= 0) throw new Error("select-pilot count must be a positive integer");
  const maxBytesText = value(args, "--max-bytes");
  const maxCanonicalBytes = maxBytesText === undefined ? undefined : Number(maxBytesText);
  if (maxCanonicalBytes !== undefined && (!Number.isInteger(maxCanonicalBytes) || maxCanonicalBytes <= 0)) throw new Error("select-pilot --max-bytes must be a positive integer");
  await writeJson("-", selectPilot(await readInventory(inventoryPath), count, { maxCanonicalBytes, includeLargest: has(args, "--include-largest") }));
}

async function dryRunExtract(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const inputPath = args[1];
  if (!inputPath) throw new Error("dry-run-extract requires a canonical JSONL file");
  const mode = value(args, "--mode") ?? "concise";
  if (mode !== "concise" && mode !== "verbose") throw new Error("dry-run-extract mode must be concise or verbose");
  const client = new HindsightClient(config.hindsight);
  await client.ensureBank();
  const content = await fs.readFile(inputPath, "utf8");
  await writeJson("-", await client.dryRunExtract(content, { retain_extraction_mode: mode }));
}

async function enableAutoConsolidation(config: ReturnType<typeof loadConfig>): Promise<void> {
  await withLock(config, async () => {
    const client = new HindsightClient(config.hindsight);
    await client.ensureBank();
    await client.updateBankConfig({ enable_observations: true, enable_auto_consolidation: true });
  });
  process.stdout.write(`${JSON.stringify({ ok: true, enable_auto_consolidation: true })}\n`);
}

async function exportCanonical(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const source = sourceArg(["--source", args[1]!]);
  const nativeId = args[2];
  const outputPath = args[3];
  if (!source || !nativeId || !outputPath) throw new Error("export-canonical requires SOURCE SESSION_ID OUTPUT_FILE");
  const adapter = createAdapters(config).find((candidate) => candidate.source === source);
  if (!adapter) throw new Error(`No adapter for ${source}`);
  let reference;
  for await (const candidate of adapter.discover()) if (candidate.nativeSessionId === nativeId) { reference = candidate; break; }
  if (!reference) throw new Error(`Session not found: ${source}:${nativeId}`);
  const session = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
  try { await fs.copyFile(session.contentPath, outputPath); }
  finally { await session.cleanup(); }
  process.stdout.write(`${JSON.stringify({ source, nativeSessionId: nativeId, output: outputPath, bytes: session.canonicalBytes, hash: session.canonicalHash })}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") { usage(); return; }
  const config = loadConfig(value(args, "--config"));
  if (command === "inventory") {
    const limitText = value(args, "--limit");
    const report = await runInventory(config, { source: sourceArg(args), limit: limitText ? Number(limitText) : undefined, includeResults: !has(args, "--summary-only") });
    await writeJson(value(args, "--output"), report); return;
  }
  if (command === "scan" || command === "index-evidence") {
    const limitText = value(args, "--limit");
    const result = await withLock(config, (state) => scan(config, state, { source: sourceArg(args), limit: limitText ? Number(limitText) : undefined, force: has(args, "--force"), sessionIds: value(args, "--session-id") ? [value(args, "--session-id")!] : undefined, indexOnly: command === "index-evidence" }));
    await writeJson("-", result);
    if (result.errors > 0) process.exitCode = 1;
    return;
  }
  if (command === "daemon") { await runDaemon(config, { once: has(args, "--once"), scanFirst: !has(args, "--no-scan") }); return; }
  if (command === "drain") { await drainImporter(config, Number(value(args, "--max-ms") ?? config.hindsight.operationPollTimeoutMs), !has(args, "--no-scan")); return; }
  if (command === "process-queued") { await drainImporter(config, Number(value(args, "--max-ms") ?? config.hindsight.operationPollTimeoutMs), false); return; }
  if (command === "import-all") { await importAllCommand(config, args); return; }
  if (command === "verify-import" || command === "verify-ready") {
    const result = await verifyFullImport(config);
    await writeJson("-", result);
    const key = command === "verify-ready" ? "activationReady" : "idempotencyReady";
    if (result[key] !== true) process.exitCode = 1;
    return;
  }
  if (command === "plan-repair") {
    await writeJson(value(args, "--output"), await buildRepairPlan(config)); return;
  }
  if (command === "repair") {
    const planFile = value(args, "--plan");
    if (!planFile) throw new Error("repair requires --plan FILE");
    const plan = JSON.parse(await fs.readFile(planFile, "utf8")) as RepairPlan;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const result = await withLock(config, (state) => repairHistory(config, state, new HindsightClient(config.hindsight), plan, { maxMs: Number(value(args, "--max-ms") ?? 86400000), signal: controller.signal }));
      await writeJson("-", result);
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  if (command === "plan-cleanup") {
    await writeJson(value(args, "--output"), await buildCleanupPlan(config, new HindsightClient(config.hindsight), { includeAmbiguous: has(args, "--include-ambiguous") })); return;
  }
  if (command === "cleanup-subagents") {
    if (!has(args, "--apply")) throw new Error("cleanup-subagents requires --apply");
    const planPath = value(args, "--plan");
    if (!planPath) throw new Error("cleanup-subagents requires --plan FILE");
    const expected = JSON.parse(await fs.readFile(planPath, "utf8")) as { planHash?: string; config?: { includeAmbiguous?: boolean } };
    if (!expected.planHash) throw new Error("cleanup plan has no planHash");
    const includeAmbiguous = expected.config?.includeAmbiguous === true;
    const result = await withLock(config, async (state) => {
      const current = await buildCleanupPlan(config, new HindsightClient(config.hindsight), { includeAmbiguous });
      if (current.planHash !== expected.planHash) throw new Error(`Cleanup plan hash changed: expected ${expected.planHash}, got ${current.planHash}`);
      return cleanupSubagents(config, state, new HindsightClient(config.hindsight), { includeAmbiguous, jobIds: new Set(current.jobs.map((job) => job.jobId)) });
    });
    await writeJson("-", result); return;
  }
  if (command === "status") { await writeJson("-", status(config)); return; }
  if (command === "pause" || command === "resume") { await setPaused(config, command === "pause"); return; }
  if (command === "configure-bank") { await configureBank(config, args); return; }
  if (command === "consolidate") { await consolidate(config); return; }
  if (command === "enable-auto-consolidation") { await enableAutoConsolidation(config); return; }
  if (command === "dry-run-extract") { await dryRunExtract(config, args); return; }
  if (command === "select-pilot") { await selectPilotCommand(args); return; }
  if (command === "queue-pilot") { await queuePilotCommand(config, args); return; }
  if (command === "run-pilot") { await runPilotCommand(config, args); return; }
  if (command === "retry-failed") {
    const count = await withLock(config, async (state) => state.resetFailed());
    process.stdout.write(`${JSON.stringify({ reset: count })}\n`);
    return;
  }
  if (command === "cancel-queued") {
    const count = await withLock(config, async (state) => state.cancelQueued());
    process.stdout.write(`${JSON.stringify({ cancelled: count })}\n`);
    return;
  }
  if (command === "export-canonical") { await exportCanonical(config, args); return; }
  if (command === "doctor") { await writeJson("-", await doctor(config)); return; }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { new Logger("cli").error("Command failed", { error: errorMessage(error) }); process.exitCode = 1; });
