import { DatabaseSync } from "node:sqlite";
import { generationCounts } from "../importer/state-db.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppConfig, HindsightBankStats, HindsightOperation } from "../common/types.js";
import { errorMessage } from "../common/logging.js";
import { ERROR_MESSAGE_MAX_CHARS } from "../common/limits.js";
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

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isStatusRequest(value: unknown): value is HindsightStatusRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<HindsightStatusRequestV1>;
  return request.protocolVersion === 1 && typeof request.respond === "function";
}

function importerStatus(config: AppConfig): HindsightStatusSnapshotV1["importer"] {
  const db = new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
  try {
    db.exec("BEGIN");
    const counts = generationCounts(db);
    return { queued: counts.queued ?? 0, submitted: counts.submitted ?? 0, processing: counts.processing ?? 0, failed: counts.failed ?? 0, cleanupPending: counts.cleanup_pending ?? 0, ...importerHealth(config, db) };
  } finally { db.close(); }
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

  const signal = AbortSignal.timeout(config.hindsight.statusTimeoutMs);
  const [importerResult, serviceResult] = await Promise.allSettled([
    Promise.resolve().then(() => importerStatus(config)),
    Promise.all([client.health(signal), client.getBankStats(signal), client.listOperations("processing", signal)]),
  ]);
  if (importerResult.status === "fulfilled") {
    importer = importerResult.value;
    if (importer.paused) issues.push("Importer is paused");
    else if (!importer.running) issues.push("Importer is not running or its heartbeat is stale");
    else if (importer.staleSources > 0) issues.push(`${importer.staleSources} sources have no recent successful scan`);
    if (importer.lastError) issues.push(`Importer cycle failed: ${redactText(importer.lastError).text.slice(0, ERROR_MESSAGE_MAX_CHARS)}`);
    if (importer.scanErrors > 0) issues.push(`${importer.scanErrors} source scan errors require attention`);
    if (importer.uncertain > 0) issues.push(`${importer.uncertain} remote operations await recovery`);
  } else issues.push(`Importer state unavailable: ${redactText(errorMessage(importerResult.reason)).text.slice(0, ERROR_MESSAGE_MAX_CHARS)}`);
  if (serviceResult.status === "fulfilled") {
    service = serviceStatus(serviceResult.value[0], serviceResult.value[1], serviceResult.value[2]);
    if (!service.healthy) issues.push("Hindsight API reports an unhealthy state");
    if (!service.databaseConnected) issues.push("Hindsight database is disconnected");
  } else {
    issues.push(`Hindsight unavailable: ${redactText(errorMessage(serviceResult.reason)).text.slice(0, ERROR_MESSAGE_MAX_CHARS)}`);
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
  let inFlight: Promise<HindsightStatusSnapshotV1> | undefined;
  return pi.events.on(HINDSIGHT_STATUS_REQUEST_EVENT, (data) => {
    if (!isStatusRequest(data)) return;
    inFlight ??= collectHindsightStatus(config, client).finally(() => { inFlight = undefined; });
    data.respond(inFlight);
  });
}
