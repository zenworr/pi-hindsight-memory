import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, Source } from "../common/types.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { expectedRetainMission } from "../common/retention-policy.js";
import { activeProvider } from "../common/approval.js";
import { documentIdFor, sha256 } from "../common/hashing.js";
import { HindsightClient } from "../hindsight/client.js";
import { Logger } from "../common/logging.js";
import { normalizeSessionLabel } from "./exclusions.js";
import { StateDatabase } from "./state-db.js";
import { ImportWorker } from "./worker.js";
import { scan } from "./scanner.js";
import { sleep } from "./scheduler.js";

export interface RepairTarget {
  source: Source;
  nativeSessionId: string;
  documentId: string;
  previousHash: string;
  canonicalHash: string;
  canonicalBytes: number;
}

export interface RepairPlan {
  configurationHash: string;
  targets: RepairTarget[];
  planHash: string;
}

async function configurationHash(config: AppConfig): Promise<string> {
  return sha256(JSON.stringify({ apiUrl: config.hindsight.apiUrl, bankId: config.hindsight.bankId, sources: config.sourceRoots, codexStateDatabase: config.codexStateDatabase, opencodeDatabase: config.opencodeDatabase, exclusions: config.sessionExclusions.exactLabels.map(normalizeSessionLabel).sort(), provider: activeProvider(config), policy: RETAIN_POLICY_VERSION, mission: await expectedRetainMission() }));
}

export async function buildRepairPlan(config: AppConfig, client = new HindsightClient(config.hindsight)): Promise<RepairPlan> {
  const db = new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 1000 });
  try {
    if (db.prepare("SELECT 1 FROM generations WHERE state IN ('queued','submitted','processing','failed','cleanup_pending') LIMIT 1").get()) throw new Error("Resolve existing import or cleanup work before planning historical repair");
    const rows = db.prepare("SELECT source,native_session_id,document_id,acknowledged_hash,canonical_hash,canonical_bytes FROM sessions WHERE classification='primary' AND status IN ('imported','discovered') AND acknowledged_hash IS NOT NULL AND COALESCE(acknowledged_policy,'')<>? ORDER BY session_started_at,source,native_session_id").all(RETAIN_POLICY_VERSION) as Array<Record<string, unknown>>;
    const remote = new Map((await client.listDocuments()).map((document) => [document.id, document.content_hash]));
    const targets = rows.map((row): RepairTarget => {
      const target = { source: String(row.source) as Source, nativeSessionId: String(row.native_session_id), documentId: String(row.document_id), previousHash: String(row.acknowledged_hash), canonicalHash: String(row.canonical_hash), canonicalBytes: Number(row.canonical_bytes) };
      if (remote.get(target.documentId) !== target.previousHash) throw new Error("Remote content differs from the acknowledged state; resolve document accounting before repair");
      return target;
    });
    const unsigned = { configurationHash: await configurationHash(config), targets };
    return { ...unsigned, planHash: sha256(JSON.stringify(unsigned)) };
  } finally { db.close(); }
}

export async function repairHistory(config: AppConfig, state: StateDatabase, client: HindsightClient, plan: RepairPlan, options: { maxMs?: number; signal?: AbortSignal } = {}): Promise<{ repaired: number; planHash: string }> {
  const unsigned = { configurationHash: plan.configurationHash, targets: plan.targets };
  if (plan.planHash !== sha256(JSON.stringify(unsigned)) || plan.configurationHash !== await configurationHash(config)) throw new Error("Repair plan or configuration changed; build and review a new plan");
  if (new Set(plan.targets.map((target) => target.documentId)).size !== plan.targets.length) throw new Error("Repair plan contains duplicate documents");
  await fs.access(path.join(config.stateDirectory, "paused"));
  const deadline = AbortSignal.timeout(options.maxMs ?? 24 * 60 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const logger = new Logger("historical-repair");
  const worker = new ImportWorker(config, state, client, logger, true, true);
  await worker.preflight(signal);
  const allowed = new Set(plan.targets.map((target) => target.documentId));
  const unfinished = () => plan.targets.filter((target) => state.getSession(target.source, target.nativeSessionId)?.acknowledgedPolicy !== RETAIN_POLICY_VERSION);
  const remote = new Map((await client.listDocuments(signal)).map((document) => [document.id, document.content_hash]));
  for (const target of plan.targets) {
    const session = state.getSession(target.source, target.nativeSessionId);
    if (!session || session.documentId !== target.documentId || target.documentId !== documentIdFor(target.source, target.nativeSessionId) || !/^[a-zA-Z0-9:._-]+$/.test(target.documentId) || session.classification?.kind !== "primary" || session.status === "ambiguous_preserved") throw new Error("A repair target is no longer an eligible primary session");
    if (session.acknowledgedPolicy === RETAIN_POLICY_VERSION) continue;
    const active = state.getLatestGeneration(target.source, target.nativeSessionId);
    const owned = active?.repair && active.retainPolicyVersion === RETAIN_POLICY_VERSION && state.getOperation(active.operationId);
    if (remote.get(target.documentId) !== target.previousHash && !(owned && (remote.get(target.documentId) === undefined || remote.get(target.documentId) === active.canonicalHash))) throw new Error("A remote document changed outside the reviewed repair plan");
  }
  const limit = Math.max(2, config.maxInflightDocuments * 2);
  await fs.mkdir(config.reportDirectory, { recursive: true, mode: 0o700 });
  const progressPath = path.join(config.reportDirectory, "repair-progress.json");
  const progress = async (phase: string) => {
    const value = { planHash: plan.planHash, phase, total: plan.targets.length, repaired: plan.targets.length - unfinished().length, pending: state.pendingWorkCount(), updatedAt: new Date().toISOString() };
    await fs.writeFile(`${progressPath}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${progressPath}.tmp`, progressPath);
    logger.info("Repair progress", value);
  };
  while (unfinished().length > 0) {
    signal.throwIfAborted();
    const outstanding = state.listGenerations().filter((generation) => ["queued", "submitted", "processing", "failed", "cleanup_pending"].includes(generation.state));
    if (outstanding.some((generation) => !allowed.has(documentIdFor(generation.source, generation.nativeSessionId)))) throw new Error("Work outside the approved repair plan is pending");
    if (outstanding.some((generation) => generation.state === "failed" || generation.state === "cleanup_pending")) throw new Error("Repair has unresolved errors; inspect status before resuming");
    const busy = new Set(outstanding.map((generation) => documentIdFor(generation.source, generation.nativeSessionId)));
    const next = outstanding.some((generation) => generation.error) ? [] : unfinished().filter((target) => !busy.has(target.documentId)).slice(0, Math.max(0, limit - outstanding.length));
    for (const source of new Set(next.map((target) => target.source))) {
      const ids = next.filter((target) => target.source === source).map((target) => target.nativeSessionId);
      const scanned = await scan(config, state, { source, sessionIds: ids, force: true, signal });
      if (scanned.errors || scanned.results.some((result) => result.status !== "eligible") || scanned.discovered !== ids.length) throw new Error("A repair source changed, disappeared, or failed validation");
    }
    const batch = await worker.runOnce(limit, signal);
    await progress("retaining");
    if (batch.failed || state.listGenerations().some((generation) => ["submitted", "processing"].includes(generation.state) && generation.error)) throw new Error("Historical repair stopped after an unresolved operation error");
    if (!batch.selected) throw new Error("Historical repair has no claimable work");
  }
  await progress("consolidating");
  for (;;) {
    signal.throwIfAborted();
    const stats = await client.getBankStats(signal);
    if (stats.failed_operations || stats.failed_consolidation) throw new Error("Hindsight has failed work; inspect it before consolidation can continue");
    const active = (stats.pending_operations ?? 0) + (stats.operations_by_status?.processing ?? 0);
    if (active) { await sleep(5000, signal); continue; }
    if (!stats.pending_consolidation) break;
    const operation = await client.consolidate(undefined, signal);
    if (operation.operation_id) await client.waitForOperation(operation.operation_id, signal, config.hindsight.retainWallTimeoutMs);
    else await sleep(1000, signal);
    await progress("consolidating");
  }
  const documents = new Map((await client.listDocuments(signal)).map((document) => [document.id, document.content_hash]));
  for (const target of plan.targets) if (documents.get(target.documentId) !== state.getSession(target.source, target.nativeSessionId)?.acknowledgedHash) throw new Error("Repaired document hash verification failed");
  await progress("completed");
  return { repaired: plan.targets.length, planHash: plan.planHash };
}
