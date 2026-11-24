import { Worker } from "node:worker_threads";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AppConfig, ImportBlockReason } from "../common/types.js";
import { errorMessage } from "../common/logging.js";
import { HOUR_MS, MS_PER_SECOND } from "../common/limits.js";
import { HindsightClient, hindsightHealthFlags } from "../hindsight/client.js";
import type { ImporterHealth } from "../importer/health.js";
import { redactText } from "../canonical/redact.js";

export const HINDSIGHT_STATUS_REQUEST_EVENT = "pi-hindsight-memory:status:request:v1";

const STATUS_DETAIL_MAX_CHARS = 160;
const BYTES_PER_GIB = 1_073_741_824;
const BLOCK_LABELS: Record<ImportBlockReason, string> = {
  "disk-below-minimum": "free disk below approved minimum",
  "approval-missing": "import approval missing",
  "approval-invalid": "import approval invalid",
  "provider-not-approved": "provider or model not approved",
  "budget-exceeded": "approved budget exceeded",
  "extraction-unavailable": "fact extraction unavailable",
  "hindsight-unreachable": "Hindsight API unreachable",
};

export interface ImporterStatus extends ImporterHealth {
  available: true;
  queued: number;
  submitted: number;
  processing: number;
  failed: number;
  cleanupPending: number;
}

interface ServiceStatus {
  available: boolean;
  healthy?: boolean;
  databaseConnected?: boolean;
  documents?: number;
  pendingOperations?: number;
  processingOperations?: number;
  failedOperations?: number;
  pendingConsolidation?: number;
  failedConsolidation?: number;
  consolidationActive?: boolean;
}

export interface HindsightStatusSnapshotV1 {
  protocolVersion: 1;
  fetchedAt: string;
  apiUrl: string;
  uiUrl?: string;
  bankId: string;
  importer: ImporterStatus | ({ available: false } & Partial<Omit<ImporterStatus, "available">>);
  service: ServiceStatus;
  issues: string[];
}

export interface HindsightStatusRequestV1 {
  protocolVersion: 1;
  respond(status: Promise<HindsightStatusSnapshotV1>): void;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function issueDetail(value: string): string {
  return redactText(value).text.replace(/\p{Cc}/gu, " ").slice(0, STATUS_DETAIL_MAX_CHARS);
}

function isStatusRequest(value: unknown): value is HindsightStatusRequestV1 {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<HindsightStatusRequestV1>;
  return request.protocolVersion === 1 && typeof request.respond === "function";
}

export function waitForStatusWorker(worker: Worker, timeoutMs: number): Promise<ImporterStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<ImporterStatus>((resolve, reject) => {
    timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Importer status timed out"));
    }, timeoutMs);
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => { reject(new Error(`Importer status worker exited without a message (${code})`)); });
  }).finally(() => { clearTimeout(timer); });
}

async function importerStatus(config: AppConfig): Promise<ImporterStatus> {
  const worker = new Worker(new URL("./status-worker.js", import.meta.url), { workerData: config });
  return waitForStatusWorker(worker, config.hindsight.statusTimeoutMs);
}

function importerIssues(importer: ImporterStatus): string[] {
  const issues: string[] = [];
  if (importer.paused) issues.push("Importer is paused");
  else if (!importer.running) issues.push("Importer is not running or its heartbeat is stale");
  else if (importer.staleSources > 0) issues.push(`${importer.staleSources} sources have no recent successful scan`);
  if (importer.desktopFeedStale) issues.push("Desktop history feed is stale or unavailable");
  if (importer.blocked) {
    const { reason, action } = importer.blocked;
    const disk = importer.diskBelowMinimum;
    const measurement = disk && reason === "disk-below-minimum"
      ? ` (${(disk.availableBytes / BYTES_PER_GIB).toFixed(1)}/${(disk.minimumBytes / BYTES_PER_GIB).toFixed(1)} GiB)` : "";
    const next = reason === "disk-below-minimum" ? "Free space; imports resume automatically" : action;
    issues.push(`Imports blocked: ${BLOCK_LABELS[reason]}${measurement} — ${next}`);
  }
  if (importer.failureReasons.length) {
    const reasons = importer.failureReasons.map(({ reason, count: failures }) => importer.failureReasons.length > 1 ? `${reason}: ${failures}` : reason).join("; ");
    const action = importer.exhaustedFailures > 0 ? "fix cause; run retry-failed" : "check cause; retries are automatic";
    issues.push(`${importer.failed} session updates failed (${reasons}) — ${action}`);
  }
  if (!importer.blocked && importer.lastError) {
    const detail = importer.lastError.startsWith("Import verification failed:") ? "Import verification failed — run verify-import" : issueDetail(importer.lastError);
    issues.push(`Importer cycle failed: ${detail}`);
  }
  if (importer.scanErrors > 0) issues.push(`${importer.scanErrors} source scan errors require attention`);
  if (importer.overdueSubmissions > 0 && importer.oldestSubmittedAgeSeconds !== undefined) {
    const hours = (importer.oldestSubmittedAgeSeconds * MS_PER_SECOND / HOUR_MS).toFixed(1);
    issues.push(`${importer.overdueSubmissions} overdue submissions (oldest ${hours} h) — check Hindsight operations`);
  }
  if (importer.unresolvedSubmissions > 0) issues.push(`${importer.unresolvedSubmissions} unresolved submissions — review before retry-unresolved`);
  if (importer.quarantinedPayloads > 0) issues.push(`${importer.quarantinedPayloads} payloads use an old redaction policy — reconcile before retry`);
  const otherUncertain = importer.uncertain - importer.unresolvedSubmissions - importer.quarantinedPayloads;
  if (otherUncertain > 0) issues.push(`${otherUncertain} remote operations await recovery — check Hindsight operations`);
  return issues;
}

export async function collectHindsightStatus(
  config: AppConfig,
  client = new HindsightClient(config.hindsight),
): Promise<HindsightStatusSnapshotV1> {
  const signal = AbortSignal.timeout(config.hindsight.statusTimeoutMs);
  const [local, health, stats, operations] = await Promise.allSettled([
    importerStatus(config),
    client.health(signal), client.getBankStats(signal), client.listOperations("processing", signal),
  ]);
  const importer = local.status === "fulfilled" ? local.value : { available: false as const };
  const issues = local.status === "fulfilled" ? importerIssues(local.value) : [`Importer state unavailable: ${issueDetail(errorMessage(local.reason))}`];
  const service: ServiceStatus = { available: health.status === "fulfilled" && stats.status === "fulfilled" && operations.status === "fulfilled" };
  if (health.status === "fulfilled") {
    Object.assign(service, hindsightHealthFlags(health.value));
    if (!service.healthy) issues.push("Hindsight API reports an unhealthy state");
    if (!service.databaseConnected) issues.push("Hindsight database is disconnected");
  } else issues.push(`Hindsight health unavailable: ${issueDetail(errorMessage(health.reason))}`);
  if (stats.status === "fulfilled") {
    service.documents = count(stats.value?.total_documents);
    service.pendingOperations = count(stats.value?.pending_operations);
    service.failedOperations = count(stats.value?.failed_operations);
    service.pendingConsolidation = count(stats.value?.pending_consolidation);
    service.failedConsolidation = count(stats.value?.failed_consolidation);
  } else issues.push("Hindsight bank statistics unavailable");
  if (operations.status === "fulfilled") {
    service.processingOperations = operations.value.length;
    service.consolidationActive = operations.value.some((operation) => operation.task_type === "consolidation");
  } else issues.push("Hindsight operations unavailable");

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
