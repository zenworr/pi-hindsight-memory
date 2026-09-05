import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppConfig, HindsightBankStats, HindsightOperation } from "../common/types.js";
import { errorMessage } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { importerHealth, type ImporterHealth } from "../importer/health.js";
import { redactText } from "../canonical/redact.js";

export const HINDSIGHT_STATUS_REQUEST_EVENT = "pi-hindsight-memory:status:request:v1";

export interface HindsightStatusSnapshotV1 {
  protocolVersion: 1;
  fetchedAt: string;
  apiUrl: string;
  uiUrl?: string;
  bankId: string;
  importer: {
    queued: number;
    submitted: number;
    processing: number;
    failed: number;
    cleanupPending: number;
  } & ImporterHealth;
  service: {
    healthy: boolean;
    databaseConnected: boolean;
    documents: number;
    pendingOperations: number;
    processingOperations: number;
    failedOperations: number;
    pendingConsolidation: number;
    failedConsolidation: number;
    consolidationActive: boolean;
  };
  issues: string[];
}

export interface HindsightStatusRequestV1 {
  protocolVersion: 1;
  respond(status: Promise<HindsightStatusSnapshotV1>): void;
}

interface CommandExecutor {
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

const STATUS_TIMEOUT_MS = 4_000;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isStatusRequest(value: unknown): value is HindsightStatusRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<HindsightStatusRequestV1>;
  return request.protocolVersion === 1 && typeof request.respond === "function";
}

async function importerStatus(config: AppConfig, executor: CommandExecutor): Promise<HindsightStatusSnapshotV1["importer"]> {
  const sql = "SELECT COALESCE(SUM(state='queued'),0), COALESCE(SUM(state='submitted'),0), COALESCE(SUM(state='processing'),0), COALESCE(SUM(state='failed'),0), COALESCE(SUM(state='cleanup_pending'),0) FROM generations;";
  const result = await executor.exec("sqlite3", ["-readonly", "-noheader", "-separator", "|", config.stateDatabase, sql], { timeout: STATUS_TIMEOUT_MS });
  if (result.code !== 0) throw new Error("importer state query failed");
  const values = result.stdout.trim().split("|").map(Number);
  if (values.length !== 5 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("invalid importer state response");
  return { queued: values[0]!, submitted: values[1]!, processing: values[2]!, failed: values[3]!, cleanupPending: values[4]!, ...importerHealth(config) };
}

function serviceStatus(health: Record<string, unknown>, stats: HindsightBankStats, operations: HindsightOperation[]): HindsightStatusSnapshotV1["service"] {
  const pendingConsolidation = count(stats.pending_consolidation);
  const processingOperations = operations.length;
  return {
    healthy: health.status === "healthy",
    databaseConnected: health.database === "connected",
    documents: count(stats.total_documents),
    pendingOperations: count(stats.pending_operations),
    processingOperations,
    failedOperations: count(stats.failed_operations),
    pendingConsolidation,
    failedConsolidation: count(stats.failed_consolidation),
    consolidationActive: operations.some((operation) => operation.task_type === "consolidation"),
  };
}

export async function collectHindsightStatus(
  config: AppConfig,
  executor: CommandExecutor,
  client = new HindsightClient(config.hindsight),
): Promise<HindsightStatusSnapshotV1> {
  const issues: string[] = [];
  let importer: HindsightStatusSnapshotV1["importer"] = { queued: 0, submitted: 0, processing: 0, failed: 0, cleanupPending: 0, running: false, paused: false, scanErrors: 0, deferred: 0, unprocessed: 0, staleSources: 0, uncertain: 0 };
  let service: HindsightStatusSnapshotV1["service"] = {
    healthy: false,
    databaseConnected: false,
    documents: 0,
    pendingOperations: 0,
    processingOperations: 0,
    failedOperations: 0,
    pendingConsolidation: 0,
    failedConsolidation: 0,
    consolidationActive: false,
  };

  const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const [importerResult, serviceResult] = await Promise.allSettled([
    importerStatus(config, executor),
    Promise.all([client.health(signal), client.getBankStats(signal), client.listOperations("processing", signal)]),
  ]);
  if (importerResult.status === "fulfilled") {
    importer = importerResult.value;
    if (importer.paused) issues.push("Importer is paused");
    else if (!importer.running) issues.push("Importer is not running or its heartbeat is stale");
    else if (importer.staleSources > 0) issues.push(`${importer.staleSources} sources have no recent successful scan`);
    if (importer.lastError) issues.push(`Importer cycle failed: ${redactText(importer.lastError).text.slice(0, 1000)}`);
    if (importer.scanErrors > 0) issues.push(`${importer.scanErrors} source scan errors require attention`);
    if (importer.uncertain > 0) issues.push(`${importer.uncertain} remote operations await recovery`);
  } else issues.push(`Importer state unavailable: ${redactText(errorMessage(importerResult.reason)).text.slice(0, 1000)}`);
  if (serviceResult.status === "fulfilled") {
    service = serviceStatus(serviceResult.value[0], serviceResult.value[1], serviceResult.value[2]);
    if (!service.healthy) issues.push("Hindsight API reports an unhealthy state");
    if (!service.databaseConnected) issues.push("Hindsight database is disconnected");
  } else {
    issues.push(`Hindsight unavailable: ${redactText(errorMessage(serviceResult.reason)).text.slice(0, 1000)}`);
  }

  return {
    protocolVersion: 1,
    fetchedAt: new Date().toISOString(),
    apiUrl: redactText(config.hindsight.apiUrl).text,
    ...(config.hindsight.uiUrl ? { uiUrl: redactText(config.hindsight.uiUrl).text } : {}),
    bankId: config.hindsight.bankId,
    importer,
    service,
    issues,
  };
}

export function registerHindsightStatusProvider(pi: ExtensionAPI, config: AppConfig, client: HindsightClient): () => void {
  return pi.events.on(HINDSIGHT_STATUS_REQUEST_EVENT, (data) => {
    if (!isStatusRequest(data)) return;
    data.respond(collectHindsightStatus(config, pi, client));
  });
}
