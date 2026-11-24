import fs from "node:fs/promises";
import path from "node:path";
import { DAY_MS, MS_PER_SECOND } from "../common/limits.js";
import { ADAPTER_VERSION, CANONICAL_SCHEMA, CLASSIFICATION_POLICY_VERSION, REDACTION_POLICY_VERSION, RETAIN_POLICY_VERSION, type AppConfig, type Source } from "../common/types.js";
import { expectedRetainMission } from "../common/retention-policy.js";
import { activeProvider } from "../common/approval.js";
import { documentIdFor, sha256 } from "../common/hashing.js";
import { HindsightClient } from "../hindsight/client.js";
import { Logger } from "../common/logging.js";
import { normalizeSessionLabel } from "./exclusions.js";
import { StateDatabase } from "./state-db.js";
import { ImportWorker } from "./worker.js";
import { scan, type ReviewedSession } from "./scanner.js";
import { sleep } from "../common/async.js";

const REPAIR_QUEUE_MULTIPLIER = 2;
const PENDING_STATES = ["queued", "submitted", "processing", "failed", "cleanup_pending"];
const STALE_REPAIR = "A repair target changed or is no longer eligible; resolve pending work, then build and review a new plan";

interface RepairTarget extends ReviewedSession {
  source: Source;
  nativeSessionId: string;
  documentId: string;
  previousHash: string;
  previousPolicy: string | null;
}

export interface RepairPlan {
  configurationHash: string;
  targets: RepairTarget[];
  planHash: string;
}

async function configurationHash(config: AppConfig): Promise<string> {
  return sha256(JSON.stringify({ apiUrl: config.hindsight.apiUrl, bankId: config.hindsight.bankId, localOrigin: config.localOrigin, desktopFeed: config.desktopFeed, promotedSessions: config.promotedSessions, sources: config.sourceRoots, codexStateDatabase: config.codexStateDatabase, opencodeDatabase: config.opencodeDatabase, exclusions: config.sessionExclusions.exactLabels.map(normalizeSessionLabel).sort(), provider: activeProvider(config), policy: [RETAIN_POLICY_VERSION, CANONICAL_SCHEMA, ADAPTER_VERSION, REDACTION_POLICY_VERSION, CLASSIFICATION_POLICY_VERSION], mission: await expectedRetainMission() }));
}

function outstandingWork(state: StateDatabase) {
  return state.listGenerations().filter((generation) => PENDING_STATES.includes(generation.state));
}

async function scanTargets(config: AppConfig, state: StateDatabase, targets: RepairTarget[], inventoryOnly: boolean, signal?: AbortSignal): Promise<void> {
  for (const source of new Set(targets.map((target) => target.source))) {
    const expected = new Map(targets.filter((target) => target.source === source).map((target) => [target.nativeSessionId, target]));
    const scanned = await scan(config, state, { source, sessionIds: [...expected.keys()], force: true, inventoryOnly, signal, review: { expected, error: STALE_REPAIR } });
    if (scanned.errors) throw new Error("Repair scan failed; inspect importer scan errors");
  }
}

export async function buildRepairPlan(config: AppConfig, client = new HindsightClient(config.hindsight)): Promise<RepairPlan> {
  const state = new StateDatabase(config.stateDatabase, { readOnly: true });
  try {
    if (outstandingWork(state).length || state.listCleanupJobs().some((job) => job.phase !== "state_finalized")) throw new Error("Resolve existing import or cleanup work before planning historical repair");
    const targets: RepairTarget[] = [];
    const sessions = state.listSessions().sort((a, b) => (a.sessionStartedAt ?? "").localeCompare(b.sessionStartedAt ?? ""));
    for (const session of sessions) {
      if (session.classification?.kind !== "primary" || !["imported", "discovered"].includes(session.status) || !session.acknowledgedHash || session.acknowledgedPolicy === RETAIN_POLICY_VERSION) continue;
      if (!session.canonicalHash || !session.canonicalBytes) throw new Error(STALE_REPAIR);
      targets.push({ source: session.source, nativeSessionId: session.nativeSessionId, origin: session.sourceOrigin ?? config.localOrigin, locator: session.sourceLocator, documentId: session.documentId, previousHash: session.acknowledgedHash, previousPolicy: session.acknowledgedPolicy ?? null, canonicalHash: session.canonicalHash, canonicalBytes: session.canonicalBytes });
    }
    await scanTargets(config, state, targets, true);
    const remote = new Map((await client.listDocuments()).map((document) => [document.id, document.content_hash]));
    if (targets.some((target) => remote.get(target.documentId) !== target.previousHash)) throw new Error("Remote content differs from the acknowledged state; resolve document accounting before repair");
    const unsigned = { configurationHash: await configurationHash(config), targets };
    return { ...unsigned, planHash: sha256(JSON.stringify(unsigned)) };
  } finally { state.close(); }
}

export async function repairHistory(config: AppConfig, state: StateDatabase, client: HindsightClient, plan: RepairPlan, options: { maxMs?: number; signal?: AbortSignal } = {}): Promise<{ repaired: number; planHash: string }> {
  const unsigned = { configurationHash: plan.configurationHash, targets: plan.targets };
  if (plan.planHash !== sha256(JSON.stringify(unsigned)) || plan.configurationHash !== await configurationHash(config)) throw new Error("Repair plan or configuration changed; build and review a new plan");
  const targets = new Map(plan.targets.map((target) => [target.documentId, target]));
  if (targets.size !== plan.targets.length) throw new Error("Repair plan contains duplicate documents");
  await fs.access(path.join(config.stateDirectory, "paused"));
  const deadline = AbortSignal.timeout(options.maxMs ?? DAY_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const logger = new Logger("historical-repair");
  const worker = new ImportWorker(config, state, client, logger, true, true);
  const unfinished = () => plan.targets.filter((target) => state.getSession(target.source, target.nativeSessionId)?.acknowledgedPolicy !== RETAIN_POLICY_VERSION);
  const checkWork = () => {
    if (state.listCleanupJobs().some((job) => job.phase !== "state_finalized")) throw new Error("Work outside the approved repair plan is pending");
    const outstanding = outstandingWork(state);
    for (const generation of outstanding) {
      const target = targets.get(documentIdFor(generation.source, generation.nativeSessionId));
      if (!target) throw new Error("Work outside the approved repair plan is pending");
      if (generation.canonicalHash !== target.canonicalHash || generation.retainPolicyVersion !== RETAIN_POLICY_VERSION || !generation.repair) throw new Error(STALE_REPAIR);
      const operation = state.getOperation(generation.operationId);
      if (operation && (operation.documentId !== target.documentId || operation.canonicalHash !== target.canonicalHash)) throw new Error(STALE_REPAIR);
      if (generation.state === "failed" || generation.state === "cleanup_pending") throw new Error("Repair has unresolved errors; inspect status before resuming");
    }
    return outstanding;
  };
  const checkTargets = async (mustBeComplete: boolean) => {
    const work = new Map(checkWork().map((generation) => [documentIdFor(generation.source, generation.nativeSessionId), generation]));
    const remote = new Map((await client.listDocuments(signal)).map((document) => [document.id, document.content_hash]));
    for (const target of plan.targets) {
      const session = state.getSession(target.source, target.nativeSessionId);
      if (!session || session.documentId !== target.documentId || target.documentId !== documentIdFor(target.source, target.nativeSessionId) || !/^[a-zA-Z0-9:._-]+$/.test(target.documentId) || (session.sourceOrigin ?? config.localOrigin) !== target.origin || session.sourceLocator !== target.locator || session.classification?.kind !== "primary" || !["imported", "discovered"].includes(session.status) || session.canonicalHash !== target.canonicalHash || session.canonicalBytes !== target.canonicalBytes) throw new Error(STALE_REPAIR);
      const remoteHash = remote.get(target.documentId);
      const generation = work.get(target.documentId);
      if (session.acknowledgedPolicy === RETAIN_POLICY_VERSION) {
        if (generation || session.acknowledgedHash !== target.canonicalHash || remoteHash !== target.canonicalHash) throw new Error(`Repaired document hash verification failed. ${STALE_REPAIR}`);
        continue;
      }
      if (mustBeComplete || session.acknowledgedHash !== target.previousHash || (session.acknowledgedPolicy ?? null) !== target.previousPolicy) throw new Error(STALE_REPAIR);
      const operation = generation && state.getOperation(generation.operationId);
      if (remoteHash !== target.previousHash && !(operation && (remoteHash === undefined || remoteHash === target.canonicalHash))) throw new Error(`A remote document changed outside the reviewed repair plan. ${STALE_REPAIR}`);
    }
  };
  if (!plan.targets.length) {
    checkWork();
    return { repaired: 0, planHash: plan.planHash };
  }
  await checkTargets(false);
  await scanTargets(config, state, plan.targets, true, signal);
  await worker.preflight(signal);
  const limit = Math.max(REPAIR_QUEUE_MULTIPLIER, config.maxInflightDocuments * REPAIR_QUEUE_MULTIPLIER);
  await fs.mkdir(config.reportDirectory, { recursive: true, mode: 0o700 });
  const progressPath = path.join(config.reportDirectory, "repair-progress.json");
  const progress = async (phase: string) => {
    const value = { planHash: plan.planHash, phase, total: plan.targets.length, repaired: plan.targets.length - unfinished().length, pending: state.pendingWorkCount(config.importer.maxAttempts), updatedAt: new Date().toISOString() };
    await fs.writeFile(`${progressPath}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(`${progressPath}.tmp`, progressPath);
    logger.info("Repair progress", value);
  };
  while (unfinished().length > 0) {
    signal.throwIfAborted();
    const outstanding = checkWork();
    const busy = new Set(outstanding.map((generation) => documentIdFor(generation.source, generation.nativeSessionId)));
    const next = outstanding.some((generation) => generation.error) ? [] : unfinished().filter((target) => !busy.has(target.documentId)).slice(0, Math.max(0, limit - outstanding.length));
    await scanTargets(config, state, next, false, signal);
    checkWork();
    const batch = await worker.runOnce(limit, signal);
    await progress("retaining");
    if (batch.blocked) throw new Error(`Import blocked (${batch.blocked.reason}): ${batch.blocked.action}`);
    if (batch.failed || checkWork().some((generation) => ["submitted", "processing"].includes(generation.state) && generation.error)) throw new Error("Historical repair stopped after an unresolved operation error");
    if (!batch.selected) throw new Error("Historical repair has no claimable work");
  }
  await checkTargets(true);
  await progress("consolidating");
  let failedConsolidation: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const stats = await client.getBankStats(signal);
    failedConsolidation ??= stats.failed_consolidation ?? 0;
    if ((stats.failed_consolidation ?? 0) > failedConsolidation) throw new Error("Hindsight consolidation failed during repair; inspect it before resuming");
    const active = (stats.pending_operations ?? 0) + (stats.operations_by_status?.processing ?? 0);
    if (active) { await sleep(config.hindsight.operationPollMs, signal); continue; }
    if (!stats.pending_consolidation) break;
    const operation = await client.consolidate(undefined, signal);
    if (operation.operation_id) await client.waitForOperation(operation.operation_id, signal, config.hindsight.retainWallTimeoutMs);
    else await sleep(MS_PER_SECOND, signal);
    await progress("consolidating");
  }
  await checkTargets(true);
  await progress("completed");
  return { repaired: plan.targets.length, planHash: plan.planHash };
}
