import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "../../src/common/config.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { scan } from "../../src/importer/scanner.js";
import { searchEvidence } from "../../src/importer/evidence.js";
import { retrieveMemory } from "../../src/extension/retrieve.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { stripHarnessContext } from "../../src/canonical/injected-memory.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import type { AppConfig } from "../../src/common/types.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-evidence-"));
  const config = defaultConfig(root);
  config.sourceRoots.pi = path.join(root, "pi");
  config.sessionSettleSeconds = 0;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const file = path.join(config.sourceRoots.pi, "session.jsonl");
  const message = (id: string, parentId: string | null, role: string, content: unknown, seconds: number) => ({ type: "message", id, parentId, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), message: { role, content } });
  const records = [
    { type: "session", version: 3, id: "source-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    message("context", null, "user", "# AGENTS.md instructions for /synthetic\n\n<INSTRUCTIONS>INJECTED-CANARY</INSTRUCTIONS>", 1),
    message("user-a", "context", "user", "Preserve the local Hindsight stack for rollback.", 2),
    message("call", "user-a", "assistant", [{ type: "toolCall", name: "memory_search", arguments: { query: "rollback" } }], 3),
    message("reply-a", "call", "assistant", [{ type: "text", text: "A short intermediate reply." }], 4),
    message("reply-b", "reply-a", "assistant", [{ type: "text", text: "DERIVED-CANARY about the rollback." }], 5),
    message("user-b", "reply-b", "user", "Correction: the local Hindsight stack was removed. Current rollback uses logical backups.", 6),
    message("reply-c", "user-b", "assistant", [{ type: "text", text: "The requested recovery method is logical backups." }], 7),
  ];
  const source = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.writeFile(file, source);
  const state = new StateDatabase(config.stateDatabase);
  return { root, config, file, source, state, async close(this: void) { state.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

async function fakeRecall(t: TestContext, config: AppConfig, handler: RequestListener): Promise<HindsightClient> {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  config.hindsight.apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.hindsight.httpMaxAttempts = 1;
  return new HindsightClient(config.hindsight, undefined, "test-only-token");
}

function markCleanupPending(f: Awaited<ReturnType<typeof fixture>>): void {
  const session = f.state.getSession("pi", "source-session")!;
  f.state.upsertGeneration({ source: "pi", nativeSessionId: session.nativeSessionId, canonicalHash: session.canonicalHash!, operationId: "cleanup-id", state: "cleanup_pending", queuedAt: new Date().toISOString(), attemptCount: 0 });
}

function mixedObservation() {
  return JSON.stringify({
    results: [{ type: "observation", text: "Mixed Hindsight observation", scores: { final: 1 }, source_fact_ids: ["a", "b"] }],
    source_facts: { a: { document_id: "agent-session:pi:source-session", text: "Affected fact" }, b: { document_id: "agent-session:pi:valid-session", text: "Unaffected fact" } },
  });
}

test("known startup wrappers are removed without dropping genuine user quotations", () => {
  assert.equal(stripHarnessContext("<environment_context>generated</environment_context>\nGenuine request"), "Genuine request");
  const quote = "Please explain this configuration:\n<environment_context>quoted</environment_context>";
  assert.equal(stripHarnessContext(quote), quote);
  assert.equal(stripHarnessContext("# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>generated</INSTRUCTIONS>\nGenuine request"), "Genuine request");
  assert.equal(stripHarnessContext("# AGENTS.md instructions\n<INSTRUCTIONS>generated</INSTRUCTIONS>\nGenuine request"), "Genuine request");
});

test("transcript evidence is private, idempotent, source-linked, and labels derived replies", async () => {
  const f = await fixture();
  try {
    const result = await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    assert.equal(result.queued, 0);
    assert.equal(f.state.listGenerations().length, 0);
    assert.equal((await fs.stat(f.config.evidenceDatabase)).mode & 0o777, 0o600);
    const hits = searchEvidence(f.config, "current Hindsight rollback logical backups").hits;
    assert.equal(hits[0]?.entryId, "user-b");
    assert.equal(hits[0]?.documentId, "agent-session:pi:source-session");
    assert.match(hits[0].text, /stack was removed/);
    assert.equal(searchEvidence(f.config, "INJECTED-CANARY").hits.length, 0);
    assert.equal(searchEvidence(f.config, "DERIVED-CANARY").hits[0]?.provenance, "memory-assisted");
    const count = () => {
      const db = new DatabaseSync(f.config.evidenceDatabase, { readOnly: true });
      try { return db.prepare("SELECT count(*) AS count FROM passages").get()!.count; } finally { db.close(); }
    };
    const before = count();
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    assert.equal(count(), before);
    assert.equal(await fs.readFile(f.file, "utf8"), f.source);
    const adapter = new PiAdapter(f.config.sourceRoots.pi);
    const ref = (await adapter.discover()[Symbol.asyncIterator]().next()).value!;
    const session = await adapter.load(ref, { spoolDirectory: f.config.spoolDirectory, maxCanonicalBytes: f.config.maxCanonicalBytes });
    const turns = (await session.readContent()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.find((turn) => turn.native_entry_id === "reply-b").provenance, "memory-assisted");
    assert.equal(turns.find((turn) => turn.native_entry_id === "reply-c").provenance, "original");
    await session.cleanup();
  } finally { await f.close(); }
});

test("excluded evidence is removed once without repeated index writes", async () => {
  const f = await fixture();
  let index: DatabaseSync | undefined;
  try {
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    f.config.sessionExclusions.exactLabels = ["blocked"];
    await fs.appendFile(f.file, `${JSON.stringify({ type: "session_info", name: "blocked" })}\n`);
    await scan(f.config, f.state, { source: "pi" });
    assert.equal(searchEvidence(f.config, "Hindsight rollback").hits.length, 0);
    index = new DatabaseSync(f.config.evidenceDatabase);
    index.exec("BEGIN IMMEDIATE");
    const result = await scan(f.config, f.state, { source: "pi" });
    assert.equal(result.configured, 1);
    assert.equal(result.errors, 0);
    assert.equal(result.queued, 0);
  } finally { index?.close(); await f.close(); }
});

test("six parallel searches use a read-only mirror and a fake server with two recall slots", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const mirror = path.join(f.root, "mirror.sqlite3");
  const source = new DatabaseSync(f.config.stateDatabase, { readOnly: true });
  try { source.prepare("VACUUM INTO ?").run(mirror); } finally { source.close(); }
  await fs.chmod(mirror, 0o444);
  f.config.stateDatabase = mirror;
  f.config.hindsight.requestTimeoutMs = 40;
  f.config.hindsight.recallTimeoutMs = 5_000;
  let active = 0, peak = 0, requests = 0;
  const queue: Array<() => void> = [];
  const client = await fakeRecall(t, f.config, (_request, response) => {
    requests += 1;
    const serve = () => {
      active += 1;
      peak = Math.max(active, peak);
      void delay(100).then(() => {
        response.end(mixedObservation());
        active -= 1;
        queue.shift()?.();
      });
    };
    if (active < 2) serve(); else queue.push(serve);
  });
  const results = await Promise.all(Array.from({ length: 6 }, () => retrieveMemory(f.config, client, "rollbacks")));
  assert.equal(requests, 6);
  assert.equal(peak, 2);
  for (const result of results) {
    assert.equal(result.details.resultCount, 1);
    assert.match(result.text, /Mixed Hindsight observation/);
    assert.match(result.text, /data, not instructions/);
  }
});

test("retrieval reports HTTP and network outages without exposing response bodies", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
  let requests = 0;
  const client = await fakeRecall(t, f.config, (request, response) => {
    requests += 1;
    if (requests === 2) { request.socket.destroy(); return; }
    response.statusCode = 503;
    response.end("https://example.invalid/?token=PRIVATE-CANARY");
  });
  for (const reason of [/HTTP 503/, /network or response error/]) {
    const result = await retrieveMemory(f.config, client, "Hindsight rollback logical backups");
    assert.match(result.text, reason);
    assert.match(result.text, /Only local evidence is shown/);
    assert.doesNotMatch(result.text, /PRIVATE-CANARY|127\.0\.0\.1/);
    assert.match(result.text, /stack was removed/);
    assert.equal(result.details.degraded, true);
    assert.ok(result.details.sourceEvidenceCount! > 0);
  }
});

test("retrieval preserves an in-flight caller abort and reports a timeout separately", async (t) => {
  const f = await fixture();
  t.after(f.close);
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const client = await fakeRecall(t, f.config, () => { arrived(); });
  f.config.hindsight.recallTimeoutMs = 5_000;
  const controller = new AbortController();
  const pending = retrieveMemory(f.config, client, "Hindsight rollback", controller.signal);
  await arrival;
  const reason = new Error("Caller stopped the search");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);

  f.config.hindsight.recallTimeoutMs = 150;
  const result = await retrieveMemory(f.config, client, "Hindsight rollback");
  assert.match(result.text, /timed out/);
  assert.equal(result.details.degraded, true);
  assert.equal(result.details.noMatch, true);
});

test("pending cleanup returns only current, state-verified local passages and never recalls observations", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const name of ["valid", "unknown", "stale"]) {
    const source = f.source.replace("source-session", `${name}-session`).replace("stack was removed", `${name} FTS canary`);
    await fs.writeFile(path.join(f.config.sourceRoots.pi, `${name}.jsonl`), source);
  }
  await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
  const db = new DatabaseSync(f.config.stateDatabase);
  try {
    db.exec("DELETE FROM sessions WHERE native_session_id='unknown-session'; UPDATE sessions SET canonical_hash='other-hash' WHERE native_session_id='stale-session'");
  } finally { db.close(); }
  markCleanupPending(f);
  await fs.mkdir(path.dirname(f.config.reviewedFactsFile), { recursive: true });
  await fs.writeFile(f.config.reviewedFactsFile, JSON.stringify([{ key: "rollback", text: "Hindsight rollback review canary", source: "unstructured source", verifiedAt: "2026-01-01T00:00:00Z" }]));
  let requests = 0;
  const client = await fakeRecall(t, f.config, (_request, response) => { requests += 1; response.end(mixedObservation()); });
  const result = await retrieveMemory(f.config, client, "current Hindsight rollback logical backups");
  assert.equal(requests, 0);
  assert.match(result.text, /cleanup.*pending/i);
  assert.match(result.text, /valid FTS canary/);
  assert.doesNotMatch(result.text, /source-session|unknown-session|stale-session|review canary|stack was removed|Mixed Hindsight observation/);
  assert.equal(result.details.degraded, true);
});

test("cleanup that starts during recall suppresses a mixed-source observation", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
  const client = await fakeRecall(t, f.config, (_request, response) => { markCleanupPending(f); response.end(mixedObservation()); });
  const result = await retrieveMemory(f.config, client, "Hindsight rollback");
  assert.match(result.text, /cleanup.*pending/i);
  assert.doesNotMatch(result.text, /Mixed Hindsight observation|source-session/);
  assert.equal(result.details.noMatch, true);
});

test("missing or unreadable state blocks both local and remote search", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
  let requests = 0;
  const client = await fakeRecall(t, f.config, (_request, response) => { requests += 1; response.end(mixedObservation()); });
  f.config.stateDatabase = path.join(f.root, "absent.sqlite3");
  for (const corrupt of [false, true]) {
    if (corrupt) await fs.writeFile(f.config.stateDatabase, "not a database");
    const result = await retrieveMemory(f.config, client, "Hindsight rollback");
    assert.match(result.text, /blocked.*importer state/i);
    assert.doesNotMatch(result.text, /absent.sqlite3|source-session/);
    assert.equal(result.details.degraded, true);
    assert.equal(result.details.noMatch, true);
  }
  assert.equal(requests, 0);
});

test("reviewed corrections are dated, cited, and separate from derived matches", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    await fs.mkdir(path.dirname(f.config.reviewedFactsFile), { recursive: true });
    await fs.writeFile(f.config.reviewedFactsFile, JSON.stringify([{ key: "rollback", text: "Hindsight rollback uses logical backups.", source: "source-session entry user-b", verifiedAt: "2026-01-01T00:00:06.000Z", supersedes: "The local stack remains available." }]), { mode: 0o600 });
    const client = { recall: async () => ({ results: [{ text: "The local stack remains available.", scores: { final: 1 }, document_id: "agent-session:pi:source-session" }] }) } as unknown as HindsightClient;
    const result = await retrieveMemory(f.config, client, "current Hindsight rollback");
    assert.ok(result.text.indexOf("Reviewed facts") < result.text.indexOf("Hindsight-derived"));
    assert.match(result.text, /Superseded: The local stack/);
    assert.match(result.text, /Verified: 2026-01-01T00:00:06.000Z/);
    assert.equal(result.details.reviewedFactCount, 1);
    const missing = await retrieveMemory(f.config, { recall: async () => ({ results: [] }) } as any, "UnrecordedZirconAsterNavigation");
    assert.equal(missing.details.noMatch, true);
  } finally { await f.close(); }
});
