import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { scan } from "../../src/importer/scanner.js";
import { ImportWorker } from "../../src/importer/worker.js";
import { verifyFullImport } from "../../src/importer/verify.js";
import { HindsightHttpError, HindsightOperationError } from "../../src/hindsight/client.js";
import { buildRepairPlan, repairHistory } from "../../src/importer/repair.js";

const header = { type: "session", version: 3, id: "audit-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/synthetic" };
const user = (id: string, content: string, parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content } });
const lines = (entries: unknown[]) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const alpha = lines([header, user("a", "Use alpha.")]);
const beta = lines([header, user("a", "Use alpha."), user("b", "Correction: use beta.", "a")]);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-audit-"));
  const config = defaultConfig(root);
  config.sourceRoots.pi = path.join(root, "pi");
  config.sessionSettleSeconds = 0;
  config.requireImportApproval = false;
  config.maxInflightDocuments = 1;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const file = path.join(config.sourceRoots.pi, "session.jsonl");
  await fs.writeFile(file, alpha);
  const state = new StateDatabase(config.stateDatabase);
  return { root, config, file, state, async close() { state.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const change of ["append", "remove"] as const) test(`recovery polls a submitted operation before source ${change}`, async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi" });
    const old = f.state.listGenerations()[0]!;
    const controller = new AbortController();
    let interrupted = false;
    let polledAfterRestart = false;
    let oldActive = false;
    const client: any = {
      ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      retainWithOperationId: async (_session: unknown, id: string) => {
        assert.equal(oldActive, false, "a document still has an active remote writer");
        if (id === old.operationId) oldActive = true;
        return { operation_id: id };
      },
      waitForOperation: async (id: string) => {
        if (id === old.operationId && !interrupted) { interrupted = true; controller.abort(); throw new Error("shutdown"); }
        if (id === old.operationId) { polledAfterRestart = true; oldActive = false; }
        return { status: "completed" };
      },
    };
    await new ImportWorker(f.config, f.state, client).runOnce(1, controller.signal);
    assert.equal(f.state.getGeneration("pi", "audit-session", old.canonicalHash)?.state, "submitted");
    if (change === "append") {
      await fs.writeFile(f.file, beta);
      await scan(f.config, f.state, { source: "pi" });
    } else await fs.rm(f.file);
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    assert.equal(polledAfterRestart, true);
    assert.equal(f.state.getGeneration("pi", "audit-session", old.canonicalHash)?.state, "completed");
    if (change === "append") await new ImportWorker(f.config, f.state, client).runOnce(1);
  } finally { await f.close(); }
});

test("a reverted document receives a fresh operation and becomes current again", async () => {
  const f = await fixture();
  const writes: string[] = [];
  let remote = "";
  const client: any = { ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
    retainWithOperationId: async (session: any, id: string) => { writes.push(id); remote = await session.readContent(); return { operation_id: id }; },
    waitForOperation: async () => ({ status: "completed" }),
  };
  try {
    for (const text of [alpha, beta, alpha]) {
      await fs.writeFile(f.file, text);
      await scan(f.config, f.state, { source: "pi", force: true });
      await new ImportWorker(f.config, f.state, client).runOnce(1);
    }
    assert.equal(writes.length, 3);
    assert.equal(new Set(writes).size, 3);
    assert.doesNotMatch(remote, /Correction: use beta/);
    await scan(f.config, f.state, { source: "pi", force: true });
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    assert.equal(writes.length, 3, "the current content is idempotent");
  } finally { await f.close(); }
});

test("an uncertain submission retries its immutable payload after the source changes", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi" });
    const original = f.state.listGenerations()[0]!;
    const bodies: string[] = [];
    const ids: string[] = [];
    let lost = false;
    const client: any = {
      ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      retainWithOperationId: async (session: any, id: string) => {
        bodies.push(await session.readContent()); ids.push(id);
        if (!lost) { lost = true; throw new Error("lost response"); }
        return { operation_id: id };
      },
      waitForOperation: async () => {
        if (bodies.length === 1) throw new HindsightHttpError(404, "GET", "http://test/operation", "");
        return { status: "completed" };
      },
    };
    assert.equal((await new ImportWorker(f.config, f.state, client).runOnce(1)).deferred, 1);
    await fs.writeFile(f.file, beta);
    await scan(f.config, f.state, { source: "pi" });
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    assert.equal(ids[0], original.operationId);
    assert.equal(ids[1], original.operationId);
    assert.equal(bodies[0], bodies[1]);
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    assert.notEqual(ids[2], original.operationId);
    assert.match(bodies[2]!, /Correction: use beta/);
  } finally { await f.close(); }
});

test("a terminal failed operation gets a fresh retry identity", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi" });
    const ids: string[] = [];
    const client: any = {
      ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      retainWithOperationId: async (_session: unknown, id: string) => { ids.push(id); return { operation_id: id }; },
      waitForOperation: async (id: string) => { if (ids.length === 1) throw new HindsightOperationError("failed", id); return { status: "completed" }; },
    };
    assert.equal((await new ImportWorker(f.config, f.state, client).runOnce(1)).failed, 1);
    assert.equal((await new ImportWorker(f.config, f.state, client).runOnce(1)).completed, 1);
    assert.equal(new Set(ids).size, 2);
  } finally { await f.close(); }
});

test("reviewed repair resumes after deletion without deleting a submitted replacement", async () => {
  const f = await fixture();
  try {
    let remoteHash: string | undefined;
    let deletions = 0;
    const completed = new Set<string>();
    const controller = new AbortController();
    const client: any = {
      ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      getDocument: async () => remoteHash ? { id: "agent-session:pi:audit-session", content_hash: remoteHash } : undefined,
      deleteDocument: async () => { deletions += 1; remoteHash = undefined; controller.abort(); },
      retainWithOperationId: async (session: any, id: string, signal?: AbortSignal) => { signal?.throwIfAborted(); remoteHash = session.canonicalHash; completed.add(id); return { operation_id: id }; },
      waitForOperation: async (id: string) => { if (!completed.has(id)) throw new HindsightHttpError(404, "GET", "http://test/operation", ""); return { status: "completed" }; },
    };
    await scan(f.config, f.state, { source: "pi" });
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    f.state.db.prepare("UPDATE sessions SET acknowledged_policy='1'").run();
    await scan(f.config, f.state, { source: "pi", force: true });
    assert.equal(f.state.listGenerations()[0]?.repair, true);
    assert.equal((await new ImportWorker(f.config, f.state, client).runOnce(1)).failed, 1);
    assert.equal(deletions, 0);
    await new ImportWorker(f.config, f.state, client, undefined, false, true).runOnce(1, controller.signal);
    assert.equal(deletions, 1);
    await fs.writeFile(f.file, beta);
    const resumed = await new ImportWorker(f.config, f.state, client, undefined, false, true).runOnce(1);
    assert.equal(resumed.completed, 1);
    assert.equal(deletions, 1);
    assert.equal(remoteHash, f.state.getSession("pi", "audit-session")?.acknowledgedHash);
    assert.equal(f.state.getSession("pi", "audit-session")?.acknowledgedPolicy, "2");
    await scan(f.config, f.state, { source: "pi", force: true });
    assert.equal((await new ImportWorker(f.config, f.state, client).runOnce(1)).completed, 1);
    assert.equal(deletions, 1);
  } finally { await f.close(); }
});

test("a cached payload cannot bypass a new configured exclusion", async () => {
  const f = await fixture();
  try {
    f.config.sessionExclusions.exactLabels = ["private-session"];
    let submissions = 0;
    const client: any = { ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      retainWithOperationId: async () => { submissions += 1; throw new Error("lost response"); },
      waitForOperation: async () => { throw new HindsightHttpError(404, "GET", "http://test/operation", ""); },
    };
    await scan(f.config, f.state, { source: "pi" });
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    await fs.appendFile(f.file, lines([{ type: "session_info", name: "private-session" }]));
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    assert.equal(submissions, 1);
    assert.equal(f.state.getSession("pi", "audit-session")?.status, "excluded_configured");
    assert.equal(f.state.getLatestGeneration("pi", "audit-session")?.state, "cleanup_pending");
  } finally { await f.close(); }
});

test("a frozen ambiguous snapshot is not reimported when source markers change", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi" });
    const generation = f.state.listGenerations()[0]!;
    f.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "completed");
    f.state.setSessionClassification("pi", "audit-session", { kind: "ambiguous", reason: "reviewed snapshot", policyVersion: "2" }, "ambiguous_preserved");
    await fs.writeFile(f.file, beta);
    const result = await scan(f.config, f.state, { source: "pi", force: true });
    assert.equal(result.queued, 0);
    assert.equal(f.state.getSession("pi", "audit-session")?.status, "ambiguous_preserved");
    assert.equal(f.state.getSession("pi", "audit-session")?.canonicalHash, generation.canonicalHash);
  } finally { await f.close(); }
});

test("historical repair is plan-bound, resumable, and verifies final hashes", async () => {
  const f = await fixture();
  try {
    let remoteHash: string | undefined;
    let deleted = 0;
    const client: any = { ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
      listDocuments: async () => remoteHash ? [{ id: "agent-session:pi:audit-session", content_hash: remoteHash }] : [],
      getDocument: async () => remoteHash ? { id: "agent-session:pi:audit-session", content_hash: remoteHash } : undefined,
      getBankStats: async () => ({ pending_consolidation: 0, failed_consolidation: 0, failed_operations: 0 }),
      deleteDocument: async () => { deleted += 1; remoteHash = undefined; },
      retainWithOperationId: async (session: any, id: string) => { remoteHash = session.canonicalHash; return { operation_id: id }; },
      waitForOperation: async () => ({ status: "completed" }),
    };
    await scan(f.config, f.state, { source: "pi" });
    await new ImportWorker(f.config, f.state, client).runOnce(1);
    f.state.db.prepare("UPDATE sessions SET acknowledged_policy='1'").run();
    await fs.writeFile(path.join(f.config.stateDirectory, "paused"), "maintenance", { mode: 0o600 });
    const plan = await buildRepairPlan(f.config, client);
    assert.equal(plan.targets.length, 1);
    await assert.rejects(() => repairHistory(f.config, f.state, client, { ...plan, targets: [] }), /plan or configuration changed/);
    assert.equal(deleted, 0);
    const result = await repairHistory(f.config, f.state, client, plan, { maxMs: 10000 });
    assert.equal(result.repaired, 1);
    assert.equal(deleted, 1);
    await repairHistory(f.config, f.state, client, plan, { maxMs: 10000 });
    assert.equal(deleted, 1, "completed repair does not replay");
  } finally { await f.close(); }
});

test("readiness rejects deferred source changes and durable parsing errors", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi" });
    const g = f.state.listGenerations()[0]!;
    f.state.setGenerationState(g.source, g.nativeSessionId, g.canonicalHash, "completed", { completedAt: new Date().toISOString() });
    f.state.setSessionStatus(g.source, g.nativeSessionId, "imported");
    const client: any = { listDocuments: async () => [{ id: "agent-session:pi:audit-session", content_hash: g.canonicalHash }], getBankStats: async () => ({}), getBankConfig: async () => ({ config: { enable_auto_consolidation: true } }), assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined };
    f.config.sessionSettleSeconds = 60;
    await fs.writeFile(f.file, beta);
    await scan(f.config, f.state, { source: "pi" });
    assert.equal((await verifyFullImport(f.config, client)).continuousReady, false);
    await fs.appendFile(f.file, "{BROKEN}\n");
    const result = await scan(f.config, f.state, { source: "pi", force: true });
    assert.equal(result.errors, 1);
    assert.equal((f.state.db.prepare("SELECT count(*) AS count FROM scan_errors").get() as { count: number }).count, 1);
    assert.equal((await verifyFullImport(f.config, client)).continuousReady, false);
  } finally { await f.close(); }
});

test("Pi exclusions follow late names, renames, cleared names, and complete records", async () => {
  const f = await fixture();
  try {
    const adapter = new PiAdapter(f.config.sourceRoots.pi);
    const info = (name?: string) => ({ type: "session_info", name, id: "name", parentId: "a", timestamp: "2026-01-01T00:02:00.000Z" });
    await fs.writeFile(f.file, lines([header, info("ordinary"), user("a", "x".repeat(300_000)), info("excluded-session")]));
    f.config.sessionExclusions.exactLabels = ["excluded-session"];
    const result = await scan(f.config, f.state, { source: "pi" });
    assert.equal(result.configured, 1);
    assert.equal(result.queued, 0);
    const reference = (await adapter.discover()[Symbol.asyncIterator]().next()).value!;
    assert.equal((await adapter.classify(reference)).label, "excluded-session");
    await fs.appendFile(f.file, JSON.stringify(info("incomplete")));
    assert.equal((await adapter.classify(reference)).label, "excluded-session");
    await fs.appendFile(f.file, `\n${lines([info()])}`);
    assert.equal((await adapter.classify(reference)).label, undefined);
    const tombstoned = await scan(f.config, f.state, { source: "pi" });
    assert.equal(tombstoned.configured, 1);
    assert.equal(tombstoned.queued, 0);
  } finally { await f.close(); }
});
