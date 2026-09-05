import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionReference } from "../../src/common/types.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { forEachJsonLine } from "../../src/adapters/adapter.js";
import { CanonicalSpool } from "../../src/canonical/render.js";

test("source parsing aborts between records and failed spools close cleanly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-source-abort-"));
  try {
    const file = path.join(root, "source.jsonl");
    await fs.writeFile(file, '{}\n{}\n{}\n');
    const controller = new AbortController();
    let read = 0;
    await assert.rejects(() => forEachJsonLine(file, () => { read += 1; controller.abort(); }, { signal: controller.signal }), /abort/i);
    assert.equal(read, 1);
    const spool = path.join(root, "spool");
    await assert.rejects(() => CanonicalSpool.create(spool, "agent-session:pi:example", "2026-01-01T00:00:00.000Z", 1), /exceeds/);
    assert.deepEqual(await fs.readdir(spool), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Codex label lookup fails closed and refreshes mutable titles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-codex-labels-"));
  const database = path.join(root, "state.sqlite3");
  try {
    await fs.writeFile(path.join(root, "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "example", timestamp: "2026-01-01T00:00:00.000Z", source: "cli" } }) + "\n");
    const missing = new CodexAdapter(root, database);
    await assert.rejects(async () => { for await (const _ref of missing.discover()) { /* drain discovery */ } }, /label database/);
    const writer = new DatabaseSync(database);
    writer.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT); INSERT INTO threads VALUES ('example','ordinary')");
    writer.close();
    const adapter = new CodexAdapter(root, database);
    const refs: SessionReference[] = []; for await (const ref of adapter.discover()) refs.push(ref);
    assert.equal(refs[0]?.sessionLabel, "ordinary");
    const update = new DatabaseSync(database);
    update.exec("UPDATE threads SET title='private-session'"); update.close();
    assert.equal((await adapter.classify(refs[0]!)).label, "private-session");
    const drift = new DatabaseSync(database);
    drift.exec("ALTER TABLE threads RENAME COLUMN title TO unsupported"); drift.close();
    await assert.rejects(() => adapter.classify(refs[0]!), /label database/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("OpenCode fingerprints cover middle edits and WAL writers can commit during a consistent read", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-opencode-hash-"));
  const database = path.join(root, "source.sqlite3");
  const writer = new DatabaseSync(database);
  const originalAdd = CanonicalSpool.prototype.add;
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT)");
    writer.exec("INSERT INTO session VALUES ('example',NULL,'ordinary',1760000000000,1760000000000)");
    writer.prepare("INSERT INTO message VALUES ('m','example',1,1,?)").run(JSON.stringify({ role: "user" }));
    const body = (value: string) => JSON.stringify({ type: "text", text: `prefix ${"x".repeat(40000)} ${value} ${"y".repeat(40000)} suffix` });
    writer.prepare("INSERT INTO part VALUES ('p','m','example',1,1,?)").run(body("version-A"));
    const adapter = new OpenCodeAdapter(database);
    const refs: SessionReference[] = []; for await (const ref of adapter.discover()) refs.push(ref);
    const reference = refs[0]!;
    const before = await adapter.fingerprint(reference);
    writer.prepare("UPDATE part SET data=? WHERE id='p'").run(body("version-B"));
    const after = await adapter.fingerprint(reference);
    assert.notEqual(before.sampleHash, after.sampleHash);
    assert.equal(before.mtimeMs, after.mtimeMs);
    let concurrentWrite = false;
    CanonicalSpool.prototype.add = async function (turn) {
      if (turn.role === "user") {
        writer.prepare("UPDATE part SET data=? WHERE id='p'").run(body("version-C"));
        concurrentWrite = true;
      }
      await originalAdd.call(this, turn);
    };
    const session = await adapter.load(reference, { spoolDirectory: path.join(root, "spool"), maxCanonicalBytes: 1000000 });
    assert.equal(concurrentWrite, true);
    assert.match(await session.readContent(), /version-B/);
    assert.doesNotMatch(await session.readContent(), /version-C/);
    await session.cleanup();
    CanonicalSpool.prototype.add = originalAdd;
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    assert.equal(checkpoint.busy, 0);
    writer.prepare("UPDATE part SET data=? WHERE id='p'").run('{"secret":"not-for-errors"');
    await assert.rejects(() => adapter.load(reference, { spoolDirectory: path.join(root, "spool"), maxCanonicalBytes: 1000000 }), (error: any) => /not a valid JSON object/.test(error.message) && !error.message.includes("not-for-errors"));
    assert.deepEqual(await fs.readdir(path.join(root, "spool")), []);
  } finally { CanonicalSpool.prototype.add = originalAdd; writer.close(); await fs.rm(root, { recursive: true, force: true }); }
});
