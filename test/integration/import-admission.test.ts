import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { defaultConfig } from "../../src/common/config.js";
import { estimateInputTokens } from "../../src/common/approval.js";
import type { ImportApproval } from "../../src/common/types.js";
import { expectedRetainMission } from "../../src/common/retention-policy.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { runDaemon, runImportCycle } from "../../src/importer/daemon.js";
import { searchEvidence } from "../../src/importer/evidence.js";
import { importAll } from "../../src/importer/historical.js";
import { scan } from "../../src/importer/scanner.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";

const approval: ImportApproval = { provider: "test-provider", model: "test-model", privacy: "remote-redacted", approvedAt: "2026-01-01T00:00:00Z", maxEstimatedInputTokens: null, maxEstimatedCostUsd: 0 };
const fixtureFiles = path.resolve("test/fixtures");

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-admission-"));
  const config = defaultConfig(root);
  config.sessionSettleSeconds = 0;
  config.importer.retryDelayMs = 20;
  config.hindsight.httpMaxAttempts = 1;
  const state = new StateDatabase(config.stateDatabase);
  for (const file of [config.approvalFile, config.hindsight.environmentFile, config.hindsight.apiTokenFile]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_PROVIDER=test-provider\nHINDSIGHT_API_LLM_MODEL=test-model\n");
  await fs.writeFile(config.hindsight.apiTokenFile, "synthetic-test-token\n");
  const writeApproval = (overrides: Partial<ImportApproval> = {}) => fs.writeFile(config.approvalFile, JSON.stringify({ ...approval, ...overrides }));
  await writeApproval();
  const addPi = async (id: string) => {
    await fs.mkdir(config.sourceRoots.pi, { recursive: true });
    const fixture = await fs.readFile(path.join(fixtureFiles, "pi/session.jsonl"), "utf8");
    const file = path.join(config.sourceRoots.pi, `${id}.jsonl`);
    await fs.writeFile(file, fixture.replaceAll("pi-fixture-001", id));
    return file;
  };
  const mission = await expectedRetainMission();
  const retains: Array<{ operation_id: string; items: { document_id: string; metadata: Record<string, string> }[] }> = [];
  const documents = new Map<string, string>();
  const operations = new Map<string, string>();
  const polls: string[] = [];
  const remote = { reject: false, unexpected: false, observations: true, autoConsolidation: true, documentReads: 0, loseReceipt: false, holdPoll: false };
  const bank = `/v1/default/banks/${config.hindsight.bankId}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1").pathname;
    const reply = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url === "/version") reply(200, { features: { observations: remote.observations } });
    else if (url === `${bank}/config`) reply(200, { config: { store_document_text: true, retain_strategies: { conversation: { retain_mission: mission.trim(), retain_extraction_mode: "concise" } }, enable_observations: true, observations_mission: "test", retain_default_strategy: "conversation", enable_auto_consolidation: remote.autoConsolidation } });
    else if (url === `${bank}/stats`) reply(200, {});
    else if (url === `${bank}/documents`) {
      remote.documentReads += 1;
      const items = [...documents].map(([id, content_hash]) => ({ id, content_hash }));
      if (remote.unexpected) items.push({ id: "unexpected", content_hash: "unexpected" });
      reply(200, { items });
    } else if (url.startsWith(`${bank}/operations/`)) {
      const id = url.split("/").at(-1)!;
      polls.push(id);
      if (remote.holdPoll) return;
      const status = operations.get(id);
      reply(status ? 200 : 404, { status });
    } else if (url === `${bank}/consolidate` && req.method === "POST") reply(200, {});
    else if (url === `${bank}/memories` && req.method === "POST") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        const retain = JSON.parse(body) as typeof retains[number];
        retains.push(retain);
        if (remote.reject) { reply(400, {}); return; }
        for (const item of retain.items) documents.set(item.document_id, item.metadata.canonical_hash!);
        operations.set(retain.operation_id, "completed");
        if (remote.loseReceipt) res.destroy();
        else reply(200, { operation_id: retain.operation_id });
      });
    } else reply(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
    state.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, config, state, writeApproval, addPi, retains, polls, operations, documents, remote, worker: new ImportWorker(config, state, new HindsightClient(config.hindsight)) };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "daemon did not reach the expected state");
    await delay(15);
  }
}

function phase(state: StateDatabase): unknown {
  return state.db.prepare("SELECT phase FROM daemon_status WHERE id=1").get()?.phase;
}

test("low spool disk blocks new work without attempts, polls submitted work, and recovers automatically", async (t) => {
  const f = await fixture(t);
  f.config.importer.workBatchSize = 1;
  await f.addPi("pending");
  await f.addPi("queued");
  await f.addPi("interrupted");
  await scan(f.config, f.state);
  const interrupted = f.state.getLatestGeneration("pi", "interrupted")!;
  f.state.upsertGeneration({ ...interrupted, state: "processing", queuedAt: "2025-01-01T00:00:00Z", attemptCount: 1 });
  const queued = f.state.getLatestGeneration("pi", "queued")!;
  const pending = f.state.getLatestGeneration("pi", "pending")!;
  const pendingDoc = f.state.getSession("pi", "pending")!.documentId;
  f.state.upsertGeneration({ ...pending, state: "submitted", attemptCount: 1 });
  f.state.upsertOperation({ ...pending, documentId: pendingDoc, hindsightStatus: "pending", retryCount: 0 });
  assert.ok(f.state.reserveBudget(pending.operationId, 2, 0, null, 0));
  f.operations.set(pending.operationId, "completed");
  f.documents.set(pendingDoc, pending.canonicalHash);
  await fs.mkdir(f.config.spoolDirectory, { recursive: true });
  await f.writeApproval({ minFreeBytes: 100 });
  const statfs = fs.statfs;
  let low = true;
  let spoolChecks = 0;
  const checked = new Set<string>();
  t.mock.method(fs, "statfs", async (directory: string) => {
    checked.add(directory);
    const sample = await statfs(directory);
    if (directory === f.config.spoolDirectory) spoolChecks += 1;
    return { ...sample, bsize: 100, bavail: low && directory === f.config.spoolDirectory ? 0 : 100 };
  });
  const daemon = runDaemon(f.config, { scanFirst: false });
  try {
    await until(() => phase(f.state) === "blocked");
    const block = f.state.getImportBlock();
    assert.equal(block?.reason, "disk-below-minimum");
    assert.match(block.action, /state and spool/);
    assert.ok(Number.isFinite(Date.parse(block.since)));
    assert.deepEqual(checked, new Set([path.dirname(f.config.stateDatabase), f.config.spoolDirectory]));
    assert.deepEqual(f.state.getLatestGeneration("pi", "queued"), queued);
    assert.equal(f.state.getLatestGeneration("pi", "pending")?.state, "completed");
    assert.deepEqual(f.polls, [pending.operationId]);
    assert.equal(f.retains.length, 0);
    assert.equal(f.state.budget().reservedInputTokens, 2);
    await until(() => spoolChecks >= 2 && phase(f.state) === "blocked");
    assert.deepEqual(f.state.getImportBlock(), block);
    low = false;
    await until(() => phase(f.state) === "idle" && f.state.getLatestGeneration("pi", "queued")?.state === "completed");
    assert.equal(f.state.getImportBlock(), undefined);
    assert.equal(f.state.getLatestGeneration("pi", "queued")?.attemptCount, 1);
    assert.deepEqual(f.retains.map((item) => item.operation_id), [interrupted.operationId, queued.operationId]);
  } finally { process.emit("SIGTERM"); await daemon; }
});

test("budget refusal preserves the queued generation and resumes automatically after approval changes", async (t) => {
  const f = await fixture(t);
  await f.addPi("budget");
  await scan(f.config, f.state);
  const queued = f.state.getLatestGeneration("pi", "budget")!;
  await f.writeApproval({ maxEstimatedInputTokens: 1 });
  const load = t.mock.method(PiAdapter.prototype, "load");
  const daemon = runDaemon(f.config, { scanFirst: false });
  try {
    await until(() => phase(f.state) === "blocked");
    assert.equal(f.state.getImportBlock()?.reason, "budget-exceeded");
    assert.deepEqual(f.state.getLatestGeneration("pi", "budget"), queued);
    assert.equal(f.state.getOperation(queued.operationId), undefined);
    assert.equal(f.state.budget().reservedInputTokens, 0);
    assert.equal(f.retains.length, 0);
    assert.equal(load.mock.callCount(), 0);
    await f.writeApproval();
    await until(() => phase(f.state) === "idle");
    assert.equal(f.state.getImportBlock(), undefined);
    assert.equal(f.state.getLatestGeneration("pi", "budget")?.state, "completed");
    assert.equal(f.state.getLatestGeneration("pi", "budget")?.attemptCount, 1);
    assert.deepEqual(f.retains.map((item) => item.operation_id), [queued.operationId]);
  } finally { process.emit("SIGTERM"); await daemon; }
});

test("an admission block and shutdown during lost-receipt recovery do not duplicate a retain", async (t) => {
  const f = await fixture(t);
  await f.addPi("interrupted-retain");
  await scan(f.config, f.state);
  const queued = f.state.getLatestGeneration("pi", "interrupted-retain")!;
  await f.writeApproval({ maxEstimatedInputTokens: 1 });
  f.remote.loseReceipt = true;
  f.remote.holdPoll = true;

  let daemon = runDaemon(f.config, { scanFirst: false });
  const stop = async () => { process.emit("SIGTERM"); await daemon; };
  try {
    await until(() => phase(f.state) === "blocked");
    assert.equal(f.state.getImportBlock()?.reason, "budget-exceeded");
    assert.deepEqual(f.state.getLatestGeneration("pi", queued.nativeSessionId), queued);
    assert.equal(f.state.budget().reservedInputTokens, 0);
    assert.equal(f.retains.length, 0);
    await f.writeApproval();
    await until(() => f.polls.length > 0);
  } finally { await stop(); }

  assert.equal(phase(f.state), "stopped");
  const interrupted = f.state.getOperation(queued.operationId);
  assert.equal(interrupted?.hindsightStatus, "submitting");
  assert.ok(interrupted.submittedAt);
  assert.equal(f.state.getLatestGeneration("pi", queued.nativeSessionId)?.state, "submitted");
  assert.deepEqual(f.polls, [queued.operationId]);
  const reserved = f.state.budget().reservedInputTokens;
  assert.ok(reserved > 0);

  f.remote.holdPoll = false;
  daemon = runDaemon(f.config, { scanFirst: false });
  try {
    await until(() => phase(f.state) === "idle" && f.state.getLatestGeneration("pi", queued.nativeSessionId)?.state === "completed");
    assert.equal(f.state.getImportBlock(), undefined);
    assert.equal(f.state.getLatestGeneration("pi", queued.nativeSessionId)?.attemptCount, 1);
    assert.equal(f.state.getOperation(queued.operationId)?.submittedAt, interrupted.submittedAt);
    assert.equal(f.state.getOperation(queued.operationId)?.hindsightStatus, "completed");
    assert.equal(f.state.budget().reservedInputTokens, reserved);
    assert.deepEqual(f.retains.map((item) => item.operation_id), [queued.operationId]);
    assert.deepEqual(f.polls, [queued.operationId, queued.operationId]);
  } finally { await stop(); }
});

test("one remaining budget reservation admits only one parallel generation", async (t) => {
  const f = await fixture(t);
  await f.addPi("parallel-a");
  await f.addPi("parallel-b");
  await scan(f.config, f.state);
  const cap = Math.max(...f.state.listSessions().map((session) => estimateInputTokens(session.canonicalBytes!)));
  await f.writeApproval({ maxEstimatedInputTokens: cap });
  const result = await f.worker.runOnce();
  assert.equal(result.blocked?.reason, "budget-exceeded");
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(f.retains.length, 1);
  const remaining = f.state.listWorkCandidates(2, f.config.importer.maxAttempts);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.state, "queued");
  assert.equal(remaining[0]?.attemptCount, 0);
});

test("a retry after failed document verification does not repeat a completed full scan", async (t) => {
  const f = await fixture(t);
  f.config.scanIntervalSeconds = 3600;
  f.remote.unexpected = true;
  const discover = t.mock.method(PiAdapter.prototype, "discover");
  await fs.mkdir(f.config.sourceRoots.pi, { recursive: true });
  const daemon = runDaemon(f.config);
  try {
    await until(() => phase(f.state) === "error");
    assert.equal(discover.mock.callCount(), 1);
    const firstReads = f.remote.documentReads;
    f.remote.unexpected = false;
    await until(() => f.remote.documentReads > firstReads && phase(f.state) === "idle");
    assert.equal(discover.mock.callCount(), 1);
  } finally { process.emit("SIGTERM"); await daemon; }
});

test("historical pagination consumes two full cohorts without skipping a reference after a malformed header", async (t) => {
  const f = await fixture(t);
  await f.addPi("cohort-a");
  await f.addPi("cohort-b");
  f.remote.autoConsolidation = false;
  const malformed = path.join(f.config.sourceRoots.pi, "malformed.jsonl");
  await fs.writeFile(malformed, "{bad-json}\n");
  const result = await importAll(f.config, f.state, new HindsightClient(f.config.hindsight), { cohortSize: 1 });
  assert.deepEqual(result, { scanned: 2, queued: 2, imported: 2, cohorts: 2 });
  assert.deepEqual(f.state.listGenerations().map(({ nativeSessionId, state }) => [nativeSessionId, state]), [["cohort-a", "completed"], ["cohort-b", "completed"]]);
  assert.deepEqual(f.state.db.prepare("SELECT locator FROM scan_errors").all().map(({ locator }) => locator), [malformed]);
});

test("a broken desktop feed leaves its evidence intact while dev scans and submitted imports are polled", async (t) => {
  const f = await fixture(t);
  f.config.localOrigin = "dev";
  const sourceHome = path.join(f.root, "desktop");
  const feed = path.join(f.root, "feed");
  const generationPath = path.join(feed, "first");
  f.config.desktopFeed = { enabled: true, directory: path.join(feed, "current"), sourceHome };
  const manifest = path.join(generationPath, "manifest.json");
  const validManifest = JSON.stringify({ version: 1, origin: "desktop", sourceHome, generation: "first" });
  await fs.mkdir(path.join(generationPath, "pi"), { recursive: true });
  await fs.writeFile(manifest, validManifest);
  await fs.symlink("first", f.config.desktopFeed.directory);
  const desktopFixture = (await fs.readFile(path.join(fixtureFiles, "pi/session.jsonl"), "utf8")).replaceAll("pi-fixture-001", "desktop-owner").replace("Use PostgreSQL for", "Desktop critical token");
  await fs.writeFile(path.join(generationPath, "pi", "desktop-owner.jsonl"), desktopFixture);
  await f.addPi("submitted");
  assert.equal((await scan(f.config, f.state, { source: "pi" })).queued, 2);
  const desktop = f.state.getSession("pi", "desktop-owner")!;
  const desktopGeneration = f.state.getLatestGeneration("pi", "desktop-owner")!;
  f.state.setGenerationState("pi", "desktop-owner", desktopGeneration.canonicalHash, "completed");
  const hits = searchEvidence(f.config, "Desktop critical token").hits;
  assert.ok(hits.some((hit) => hit.documentId === desktop.documentId));
  f.documents.set(desktop.documentId, desktopGeneration.canonicalHash);
  const submitted = f.state.getLatestGeneration("pi", "submitted")!;
  const documentId = f.state.getSession("pi", "submitted")!.documentId;
  f.state.upsertGeneration({ ...submitted, state: "submitted", attemptCount: 1 });
  f.state.upsertOperation({ ...submitted, documentId, hindsightStatus: "pending", retryCount: 0 });
  f.documents.set(documentId, submitted.canonicalHash);
  f.operations.set(submitted.operationId, "completed");

  await fs.rm(f.config.desktopFeed.directory);
  await f.addPi("desktop-owner");
  await f.addPi("dev-new");
  const client = new HindsightClient(f.config.hindsight);
  const cycle = await runImportCycle(f.config, f.state, client);
  assert.equal(cycle.scan?.errors, 4);
  assert.deepEqual(f.state.db.prepare("SELECT locator FROM scan_errors").all().map(({ locator }) => locator), Array<string>(4).fill("<discovery:desktop>"));
  assert.equal(f.state.getSession("pi", "desktop-owner")?.sourceOrigin, "desktop");
  assert.equal(f.state.getSession("pi", "desktop-owner")?.status, "imported");
  assert.equal(f.state.getSession("pi", "dev-new")?.status, "imported");
  assert.ok(f.polls.includes(submitted.operationId));
  assert.equal(f.state.getLatestGeneration("pi", "submitted")?.state, "completed");
  assert.deepEqual(searchEvidence(f.config, "Desktop critical token").hits, hits);

  await fs.rm(path.join(f.config.sourceRoots.pi, "desktop-owner.jsonl"));
  await fs.symlink("first", f.config.desktopFeed.directory);
  await fs.writeFile(manifest, "{bad-json");
  assert.equal((await runImportCycle(f.config, f.state, client)).scan?.errors, 4);
  await fs.writeFile(manifest, validManifest);
  assert.equal((await scan(f.config, f.state, { source: "pi" })).errors, 0);
  assert.equal(f.state.db.prepare("SELECT locator FROM scan_errors WHERE source='pi'").get(), undefined);
});

test("worker loads exact local and pinned desktop locators without enumerating same-ID Claude sidechains", async (t) => {
  const f = await fixture(t);
  const originalHome = path.join(f.root, "desktop");
  const feed = path.join(f.root, "feed");
  f.config.localOrigin = "dev";
  f.config.desktopFeed = { enabled: true, directory: path.join(feed, "current"), sourceHome: originalHome };
  const claudeSession = await fs.readFile(path.join(fixtureFiles, "claude/session.jsonl"), "utf8");
  const sidechain = '{"sessionId":"claude-fixture-001","timestamp":"2025-12-31T00:00:00Z","isSidechain":true}\n';
  for (const generation of ["first", "next"]) {
    const directory = path.join(feed, generation);
    await fs.mkdir(path.join(directory, "claude"), { recursive: true });
    await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation }));
    await fs.writeFile(path.join(directory, "claude/0-sidechain.jsonl"), sidechain);
    await fs.writeFile(path.join(directory, "claude/primary.jsonl"), generation === "first" ? claudeSession : sidechain);
  }
  await fs.symlink("first", f.config.desktopFeed.directory);
  await fs.mkdir(f.config.sourceRoots.claude, { recursive: true });
  const local = path.join(f.config.sourceRoots.claude, "primary.jsonl");
  await fs.writeFile(local, claudeSession.replaceAll("claude-fixture-001", "local-session"));
  assert.equal((await scan(f.config, f.state, { source: "claude" })).queued, 2);
  t.mock.method(ClaudeAdapter.prototype, "discover", () => { throw new Error("Worker enumerated a source"); });
  const adapter = new ClaudeAdapter(path.join(feed, "first/claude"));
  const classify = adapter.classify.bind(adapter);
  t.mock.method(ClaudeAdapter.prototype, "classify", async (reference: Parameters<typeof classify>[0]) => {
    if (reference.nativeSessionId !== "local-session") {
      await fs.symlink("next", path.join(feed, "next-link"));
      await fs.rename(path.join(feed, "next-link"), f.config.desktopFeed.directory);
      assert.equal(reference.locator, path.join(feed, "first/claude/primary.jsonl"));
    }
    return classify(reference);
  });
  assert.equal((await f.worker.runOnce()).completed, 2);
  assert.deepEqual(f.retains.flatMap((retain) => retain.items.map((item) => item.metadata.source_path)).sort(), [local, path.join(originalHome, ".claude/projects/primary.jsonl")].sort());
});

test("worker rechecks classification after normalization and excludes a newly blocked label", async (t) => {
  const f = await fixture(t);
  const file = await f.addPi("reclassified");
  f.config.sessionExclusions.exactLabels = ["late exclusion"];
  assert.equal((await scan(f.config, f.state)).queued, 1);
  const adapter = new PiAdapter(f.config.sourceRoots.pi);
  const load = adapter.load.bind(adapter);
  t.mock.method(PiAdapter.prototype, "load", async (...args: Parameters<typeof load>) => {
    const session = await load(...args);
    await fs.appendFile(file, '{"type":"session_info","name":"late exclusion"}\n');
    return session;
  });
  assert.equal((await f.worker.runOnce()).deferred, 1);
  assert.equal(f.retains.length, 0);
  assert.equal(f.state.getSession("pi", "reclassified")?.status, "excluded_configured");
});

test("an unavailable extraction provider blocks normalization and rechecks availability on retry", async (t) => {
  const f = await fixture(t);
  await f.addPi("offline");
  await scan(f.config, f.state);
  const load = t.mock.method(PiAdapter.prototype, "load");
  f.remote.observations = false;
  assert.equal((await f.worker.runOnce()).blocked?.reason, "extraction-unavailable");
  assert.equal(f.state.getLatestGeneration("pi", "offline")?.attemptCount, 0);
  assert.equal(load.mock.callCount(), 0);
  f.remote.observations = true;
  assert.equal((await f.worker.runOnce()).completed, 1);
  await f.addPi("offline-again");
  await scan(f.config, f.state);
  f.remote.observations = false;
  assert.equal((await f.worker.runOnce()).blocked?.reason, "extraction-unavailable");
  assert.equal(f.state.getLatestGeneration("pi", "offline-again")?.attemptCount, 0);
  assert.equal(load.mock.callCount(), 2);
});

test("the failure-rate sample applies only in continuous mode and retains the breaker summary", async (t) => {
  const f = await fixture(t);
  await f.addPi("breaker");
  await scan(f.config, f.state);
  await f.writeApproval({ maxFailureRate: 0.1, continuousMinFailureSample: 2 });
  f.remote.reject = true;
  const first = await f.worker.runOnce(1, undefined, { continuous: true });
  assert.deepEqual(first, { selected: 1, completed: 0, failed: 1, deferred: 0 });
  const checkBreaker = (selected: number) => ({ message: new RegExp(`Import failure rate ${selected}/${selected}`), summary: { selected, failed: selected, completed: 0, deferred: 0 } });
  await assert.rejects(f.worker.runOnce(1), checkBreaker(1));
  await f.addPi("breaker-second");
  await scan(f.config, f.state);
  await assert.rejects(f.worker.runOnce(2, undefined, { continuous: true }), checkBreaker(2));
  await f.writeApproval({ maxFailureRate: 0.1 });
  await assert.rejects(f.worker.runOnce(1, undefined, { continuous: true }), checkBreaker(1));
  assert.equal(f.state.getLatestGeneration("pi", "breaker")?.attemptCount, f.config.importer.maxAttempts);
  assert.equal(f.state.getLatestGeneration("pi", "breaker")?.state, "failed");
});
