import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import type { FetchLike } from "../../src/hindsight/client.js";
import { withWriterLock } from "../../src/importer/lock.js";
import { nextOperationId } from "../../src/importer/queue.js";
import { scan } from "../../src/importer/scanner.js";
import { StateDatabase, UNRESOLVED_SUBMISSION } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-receipts-"));
  const config = defaultConfig(root);
  config.requireImportApproval = false;
  config.sessionSettleSeconds = 0;
  config.hindsight.operationPollMs = 10;
  config.hindsight.apiTokenFile = path.join(root, "test-token");
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const transcript = await fs.readFile(path.resolve("test/fixtures/pi/session.jsonl"), "utf8");
  let state = new StateDatabase(config.stateDatabase);
  const add = async (id: string) => {
    await fs.writeFile(path.join(config.sourceRoots.pi, `${id}.jsonl`), transcript.replaceAll("pi-fixture-001", id));
    await scan(config, state, { source: "pi" });
    return state.getLatestGeneration("pi", id)!;
  };
  const calls: string[] = [];
  const posts: string[] = [];
  const remote = {
    receipt: (id: string): unknown => ({ operation_id: id }),
    poll: (_id: string, res: http.ServerResponse) => { reply(res, 200, { status: "completed" }); },
    hash: undefined as string | undefined,
    loseReceipt: false,
  };
  const bank = `/v1/default/banks/${config.hindsight.bankId}`;
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(req.url!.slice(bank.length));
    calls.push(`${req.method} ${route}`);
    if (req.method === "POST" && route === "/memories") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      req.on("end", () => {
        const id: string = JSON.parse(Buffer.concat(chunks).toString()).operation_id;
        posts.push(id);
        if (remote.loseReceipt) res.destroy();
        else reply(res, 202, remote.receipt(id));
      });
    } else if (route.startsWith("/operations/")) remote.poll(route.split("/").at(-1)!, res);
    else if (route.startsWith("/documents/") && remote.hash) reply(res, 200, { id: route.slice("/documents/".length), content_hash: remote.hash });
    else reply(res, 404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    state.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root, add, config, calls, posts, remote,
    get state() { return state; },
    restart() { state.close(); state = new StateDatabase(config.stateDatabase); },
    run(limit = 1, signal?: AbortSignal, repair = false, fetcher?: FetchLike) {
      return new ImportWorker(config, state, new HindsightClient(config.hindsight, fetcher, "fixture-token"), undefined, false, repair).runOnce(limit, signal, { admission: {} });
    },
    runWithTokenFile(fetcher: FetchLike) {
      return new ImportWorker(config, state, new HindsightClient(config.hindsight, fetcher)).runOnce(1, undefined, { admission: {} });
    },
  };
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

for (const receipt of ["absent", "conflicting"] as const) test(`a ${receipt} receipt ID holds the submission without polling or retrying`, async (t) => {
  const f = await fixture(t);
  const g = await f.add("receipt");
  f.remote.receipt = () => receipt === "absent" ? {} : { operation_id: "unrelated-id" };
  assert.equal((await f.run()).deferred, 1);
  f.restart();
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, UNRESOLVED_SUBMISSION);
  assert.equal(f.state.unresolvedOperationCount(), 1);
  assert.equal(f.state.hasRunnableWork(f.config.importer.maxAttempts), false);
  assert.equal((await f.run()).selected, 0);
  assert.deepEqual(f.calls, ["POST /memories"]);
  assert.deepEqual(f.posts, [g.operationId]);
});

test("a submitted generation missing its operation journal does not send a retain", async (t) => {
  const f = await fixture(t);
  const g = await f.add("missing-journal");
  f.state.upsertGeneration({ ...g, state: "submitted", submittedAt: new Date().toISOString(), attemptCount: 1 });
  assert.equal((await f.run()).deferred, 1);
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, UNRESOLVED_SUBMISSION);
  assert.deepEqual(f.calls, []);
});

test("a lost POST receipt polls the original ID after restart without replaying POST", async (t) => {
  const f = await fixture(t);
  const g = await f.add("lost-receipt");
  f.remote.loseReceipt = true;
  assert.ok(f.config.hindsight.httpMaxAttempts > 1);
  assert.equal((await f.run()).deferred, 1);
  const submitted = f.state.getOperation(g.operationId)!;
  assert.equal(submitted.hindsightStatus, "submitting");
  assert.ok(submitted.submittedAt);
  f.restart();
  assert.equal((await f.run()).completed, 1);
  assert.deepEqual(f.calls, ["POST /memories", `GET /operations/${g.operationId}`]);
  assert.equal(f.state.getOperation(g.operationId)?.submittedAt, submitted.submittedAt);
  assert.equal(f.state.getOperation(g.operationId)?.lastObservedStatus, "completed");
});

test("a connection refusal restores the same retain ID for a safe retry", async (t) => {
  const f = await fixture(t);
  const g = await f.add("refused");
  const attempts: string[] = [];
  const fetcher: FetchLike = async (url, init) => {
    if (init?.method === "POST") {
      attempts.push(JSON.parse(init.body as string).operation_id as string);
      if (attempts.length === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }
    return fetch(url, init);
  };
  assert.equal((await f.run(1, undefined, false, fetcher)).deferred, 1);
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, "ready");
  assert.equal(f.state.getOperation(g.operationId)?.submittedAt, undefined);
  assert.equal(f.state.getLatestGeneration("pi", "refused")?.submittedAt, undefined);
  assert.deepEqual(f.calls, []);
  f.restart();
  assert.equal((await f.run(1, undefined, false, fetcher)).completed, 1);
  assert.equal(f.state.getLatestGeneration("pi", "refused")?.attemptCount, 1);
  assert.deepEqual(attempts, [g.operationId, g.operationId]);
  assert.deepEqual(f.calls, ["POST /memories", `GET /operations/${g.operationId}`]);
});

test("token read and invalid request headers fail before fetch and recover with the original ID", async (t) => {
  const f = await fixture(t);
  const g = await f.add("token-read");
  const fetcher = t.mock.fn(fetch);
  for (const contents of [undefined, "invalid\nheader"]) {
    if (contents) await fs.writeFile(f.config.hindsight.apiTokenFile, contents);
    assert.equal((await f.runWithTokenFile(fetcher)).deferred, 1);
    assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, "ready");
    assert.equal(f.state.getLatestGeneration("pi", g.nativeSessionId)?.submittedAt, undefined);
    assert.equal(fetcher.mock.callCount(), 0);
    f.restart();
  }
  await fs.writeFile(f.config.hindsight.apiTokenFile, "fixture-token");
  assert.equal((await f.runWithTokenFile(fetcher)).completed, 1);
  assert.deepEqual(f.calls, ["POST /memories", `GET /operations/${g.operationId}`]);
  assert.deepEqual(f.posts, [g.operationId]);
});

test("a transient content read fails before fetch and recovers with the original ID", async (t) => {
  const f = await fixture(t);
  const g = await f.add("content-read");
  const fetcher = t.mock.fn(fetch);
  assert.equal((await f.runWithTokenFile(fetcher)).deferred, 1);
  await fs.writeFile(f.config.hindsight.apiTokenFile, "fixture-token");
  const payloadPath = path.join(f.config.spoolDirectory, "pending", `${g.operationId}.jsonl`);
  const readFile = fs.readFile.bind(fs);
  const failRead = t.mock.method(fs, "readFile", (file: string, options?: BufferEncoding) => file === payloadPath
    ? Promise.reject(Object.assign(new Error("temporary file read failure"), { code: "EAGAIN" }))
    : readFile(file, options));
  assert.equal((await f.runWithTokenFile(fetcher)).deferred, 1);
  assert.equal(failRead.mock.calls.filter(call => call.arguments[0] === payloadPath).length, 1);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, "ready");
  assert.equal(f.state.getLatestGeneration("pi", g.nativeSessionId)?.submittedAt, undefined);
  failRead.mock.restore();
  f.restart();
  assert.equal((await f.runWithTokenFile(fetcher)).completed, 1);
  assert.deepEqual(f.posts, [g.operationId]);
});

test("a damaged pending payload fails locally without fetch or an unresolved submission", async (t) => {
  const f = await fixture(t);
  const g = await f.add("damaged");
  const fetcher = t.mock.fn(fetch);
  assert.equal((await f.runWithTokenFile(fetcher)).deferred, 1);
  const payloadPath = path.join(f.config.spoolDirectory, "pending", `${g.operationId}.jsonl`);
  await fs.writeFile(payloadPath, "damaged");
  assert.equal((await f.runWithTokenFile(fetcher)).failed, 1);
  const failed = f.state.getLatestGeneration("pi", g.nativeSessionId)!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.operationId, g.operationId);
  assert.match(failed.error!, /^Local payload integrity failure:/);
  assert.equal(f.state.unresolvedOperationCount(), 0);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal((await f.runWithTokenFile(fetcher)).selected, 0);
});

test("a connection reset after POST polls and holds when the operation is absent", async (t) => {
  const f = await fixture(t);
  const g = await f.add("reset");
  f.remote.poll = (_id, res) => { reply(res, 200, { status: "not_found" }); };
  const fetcher: FetchLike = async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method === "POST") {
      await response.body?.cancel();
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    return response;
  };
  assert.equal((await f.run(1, undefined, false, fetcher)).deferred, 1);
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, "submitting");
  assert.equal((await f.run()).deferred, 1);
  assert.equal(f.state.unresolvedOperationCount(), 1);
  assert.match(f.state.getLatestGeneration("pi", "reset")?.error ?? "", /retry-unresolved/);
  assert.equal((await f.run()).selected, 0);
  assert.deepEqual(f.posts, [g.operationId]);
  assert.ok(f.calls.includes(`GET /operations/${g.operationId}`));
});

test("retry-unresolved lists holds without a lock and requeues only selected IDs under the writer lock", async (t) => {
  const f = await fixture(t);
  const g = await f.add("reviewed");
  const other = await f.add("not-reviewed");
  f.remote.receipt = () => ({});
  assert.equal((await f.run(2)).deferred, 2);
  const cli = fileURLToPath(new URL("../../src/importer/cli.js", import.meta.url));
  const configFile = path.join(f.root, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ stateDatabase: f.config.stateDatabase, spoolDirectory: f.config.spoolDirectory }));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "retry-unresolved", "--config", configFile, ...args], { encoding: "utf8", env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: f.root, XDG_STATE_HOME: f.root }, timeout: 10_000 });
  const old = f.state.getOperation(g.operationId)!;
  const id = nextOperationId(f.state, f.config.hindsight.bankId, old.documentId, g.canonicalHash, old.operationId);
  const payloadPath = (id: string, suffix = "jsonl") => path.join(f.config.spoolDirectory, "pending", `${id}.${suffix}`);
  const original = await fs.readFile(payloadPath(g.operationId), "utf8");
  const otherPayload = await fs.readFile(payloadPath(other.operationId), "utf8");
  const held = [g, other].map(({ operationId, source, nativeSessionId }) => ({ operationId, source, nativeSessionId, since: f.state.getOperation(operationId)?.submittedAt }))
    .sort((a, b) => a.since!.localeCompare(b.since!) || a.operationId.localeCompare(b.operationId));
  await withWriterLock(f.config.stateDatabase, () => {
    const listed = run();
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { held });
    const result = run("--operation", g.operationId);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /writer lock is busy/);
  });
  const invalid = run("--operation", g.operationId, "--operation", "not-held");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /no holds were requeued/);
  assert.equal(f.state.unresolvedOperationCount(), 2);
  const result = run("--operation", g.operationId);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { requeued: 1 });
  assert.deepEqual(JSON.parse(run().stdout), { held: held.filter(row => row.operationId === other.operationId) });
  assert.equal(f.state.getLatestGeneration("pi", "reviewed")?.operationId, id);
  assert.equal(f.state.unresolvedOperationCount(), 1);
  assert.equal(await fs.readFile(payloadPath(other.operationId), "utf8"), otherPayload);
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, UNRESOLVED_SUBMISSION);
  assert.equal(await fs.readFile(payloadPath(id), "utf8"), original);
  for (const suffix of ["jsonl", "json"]) await assert.rejects(fs.access(payloadPath(g.operationId, suffix)), { code: "ENOENT" });
  f.remote.receipt = (id) => ({ operation_id: id });
  assert.equal((await f.run()).completed, 1);
  assert.deepEqual(f.posts.slice(0, 2).sort(), [g.operationId, other.operationId].sort());
  assert.equal(f.posts[2], id);
});

for (const [outcome, status] of [["matching hash", 200], ["mismatching hash", 200], ["no document", 404]] as const) test(`operation ${status} not_found with ${outcome} never replays`, async (t) => {
  const f = await fixture(t);
  const g = await f.add("expired");
  const match = outcome === "matching hash";
  f.remote.poll = (id, res) => { reply(res, status, { operation_id: id, status: "not_found" }); };
  f.remote.hash = match ? g.canonicalHash : outcome === "mismatching hash" ? "different" : undefined;
  assert.equal((await f.run()).completed, Number(match));
  f.restart();
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, match ? "completed" : UNRESOLVED_SUBMISSION);
  assert.equal(f.state.getOperation(g.operationId)?.lastObservedStatus, "not_found");
  assert.equal(f.state.getSession("pi", "expired")?.acknowledgedHash, match ? g.canonicalHash : undefined);
  assert.equal((await f.run()).selected, 0);
  assert.deepEqual(f.posts, [g.operationId]);
});

for (const status of ["prepared", "ready"] as const) test(`a ${status} operation can submit even if its ID is absent remotely`, async (t) => {
  const f = await fixture(t);
  const g = await f.add("prepared-local");
  const documentId = f.state.getSession("pi", "prepared-local")!.documentId;
  f.state.upsertOperation({ ...g, documentId, hindsightStatus: status, retryCount: 0 });
  f.remote.poll = (id, res) => { if (f.posts.includes(id)) reply(res, 200, { status: "completed" }); else reply(res, 404, {}); };
  const client = new HindsightClient(f.config.hindsight, undefined, "fixture-token");
  await assert.rejects(() => client.getOperation(g.operationId), { status: 404 });
  assert.equal((await f.run()).completed, 1);
  assert.deepEqual(f.calls.slice(1), ["POST /memories", `GET /operations/${g.operationId}`]);
  assert.deepEqual(f.posts, [g.operationId]);
});

test("an expired same-hash policy rewrite still needs review", async (t) => {
  const f = await fixture(t);
  const g = await f.add("policy-only");
  f.state.acknowledgeGeneration({ ...g, retainPolicyVersion: "1" });
  const session = f.state.getSession("pi", "policy-only")!;
  assert.equal(session.acknowledgedHash, g.canonicalHash);
  f.state.upsertGeneration({ ...g, repair: true, state: "submitted", attemptCount: 1 });
  f.state.upsertOperation({ ...g, documentId: session.documentId, hindsightStatus: "pending", retryCount: 0 });
  f.remote.hash = g.canonicalHash;
  f.remote.poll = (_id, res) => { reply(res, 200, { status: "not_found" }); };
  assert.equal((await f.run(1, undefined, true)).completed, 0);
  assert.equal(f.state.getSession("pi", "policy-only")?.acknowledgedPolicy, "1");
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, UNRESOLVED_SUBMISSION);
  assert.deepEqual(f.posts, []);
});

test("an unknown operation status stops polling and quarantines the submission", async (t) => {
  const f = await fixture(t);
  const g = await f.add("unknown-status");
  f.remote.poll = (_id, res) => { reply(res, 200, { status: "new-status" }); };
  assert.equal((await f.run()).deferred, 1);
  assert.equal(f.state.getOperation(g.operationId)?.lastObservedStatus, "unknown");
  assert.equal(f.state.getOperation(g.operationId)?.hindsightStatus, UNRESOLVED_SUBMISSION);
  assert.equal((await f.run()).selected, 0);
  assert.deepEqual(f.calls, ["POST /memories", `GET /operations/${g.operationId}`]);
});

test("a delayed child persists poll time separately from progress across shutdown and restart", async (t) => {
  const f = await fixture(t);
  const g = await f.add("delayed-child");
  const pollThenStop = async (retryAt: string, childStatus: string) => {
    const controller = new AbortController();
    let observed = false;
    f.remote.poll = (id, res) => {
      if (observed) { controller.abort(); return; }
      observed = true;
      reply(res, 200, { operation_id: id, status: "pending", operation_type: "batch_retain", child_operations: [{ status: childStatus, next_retry_at: retryAt }] });
    };
    assert.equal((await f.run(1, controller.signal)).deferred, 1);
    f.restart();
    return f.state.getOperation(g.operationId)!;
  };
  const first = await pollThenStop("2099-10-22T06:13:12Z", "pending");
  assert.ok(first.submittedAt && first.lastPolledAt && first.lastProgressAt);
  assert.equal(first.lastObservedStatus, "pending");
  assert.equal(first.nextRetryAt, "2099-10-22T06:13:12.000Z");
  assert.deepEqual(f.state.listActiveOperations(), [first]);
  assert.equal(f.state.getLatestGeneration("pi", "delayed-child")?.state, "submitted");
  const again = await pollThenStop("2099-10-23T06:13:12Z", "pending");
  assert.ok(again.lastPolledAt! > first.lastPolledAt);
  assert.equal(again.lastProgressAt, first.lastProgressAt);
  assert.equal(again.submittedAt, first.submittedAt);
  assert.equal(again.nextRetryAt, "2099-10-23T06:13:12.000Z");
  const advanced = await pollThenStop("2099-10-23T06:13:12Z", "processing");
  assert.ok(advanced.lastProgressAt! > again.lastProgressAt);
  assert.equal(advanced.nextRetryAt, undefined);
  assert.deepEqual(f.posts, [g.operationId]);
});

test("stalled polls leave batch space for unrelated queued documents", async (t) => {
  const f = await fixture(t);
  const first = await f.add("stalled-first");
  const second = await f.add("stalled-second");
  const queued = await f.add("unrelated");
  for (const g of [first, second]) {
    const submittedAt = "2020-01-01T00:00:00.000Z";
    f.state.upsertGeneration({ ...g, state: "submitted", submittedAt, attemptCount: 1 });
    f.state.upsertOperation({ ...g, documentId: f.state.getSession("pi", g.nativeSessionId)!.documentId, hindsightStatus: "pending", submittedAt, retryCount: 0 });
  }
  const stalled = new Set([first.operationId, second.operationId]);
  const pollIds = f.state.listWorkCandidates(2, f.config.importer.maxAttempts).map((g) => g.operationId);
  assert.equal(pollIds[0], queued.operationId);
  assert.equal(stalled.has(pollIds[1]!), true);
  assert.equal(stalled.has(f.state.listWorkCandidates(1, f.config.importer.maxAttempts, true)[0]!.operationId), true);
  f.remote.poll = (id, res) => { reply(res, 200, { status: stalled.has(id) ? "pending" : "completed" }); };
  assert.equal((await f.run(1)).completed, 1);
  assert.deepEqual(f.posts, [queued.operationId]);
  assert.equal(f.state.listWorkCandidates(2, f.config.importer.maxAttempts).length, 2);
});
