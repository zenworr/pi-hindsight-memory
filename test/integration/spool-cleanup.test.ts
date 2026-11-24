import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { withWriterLock } from "../../src/importer/lock.js";
import { STALE_REDACTION_PAYLOAD } from "../../src/importer/pending-payload.js";
import { StateDatabase, UNRESOLVED_SUBMISSION, type GenerationRecord } from "../../src/importer/state-db.js";

const cli = fileURLToPath(new URL("../../src/importer/cli.js", import.meta.url));
const queuedAt = "2026-01-01T00:00:00.000Z";
const payload = "synthetic payload";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-spool-"));
  const configPath = path.join(root, "config.json");
  const stateDatabase = path.join(root, "state.sqlite3");
  const spoolDirectory = path.join(root, "spool");
  const pending = path.join(spoolDirectory, "pending");
  const state = new StateDatabase(stateDatabase);
  t.after(async () => { state.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(pending, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ stateDatabase, spoolDirectory, hindsight: { apiUrl: "http://127.0.0.1:1" } }));
  const env = { HOME: root, PATH: process.env.PATH, PI_HINDSIGHT_TELEMETRY_FILE: "/dev/null" };
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, "spool-cleanup", "--config", configPath, ...args], { env, timeout: 10_000 });
  const write = (file: string) => fs.writeFile(path.join(pending, file), payload);
  const pair = async (id: string) => { await write(`${id}.jsonl`); await write(`${id}.json`); };
  const record = (id: string, status: string | undefined, fields: Partial<GenerationRecord> = {}, operationHash = "hash") => {
    const documentId = `agent-session:pi:${id}`;
    const sourceLocator = path.join(root, `${id}.jsonl`);
    state.upsertSession({ source: "pi", nativeSessionId: id, documentId, sourceLocator, sourceSize: 10, sourceMtime: 1, sourceFingerprint: { size: 10, mtimeMs: 1, sampleHash: "sample", stableLocator: sourceLocator, processing_signature: "v1" }, status: "discovered", lastSeenAt: queuedAt });
    state.upsertGeneration({ source: "pi", nativeSessionId: id, canonicalHash: "hash", operationId: id, state: "superseded", queuedAt, attemptCount: 1, ...fields });
    if (status) state.upsertOperation({ operationId: id, documentId, canonicalHash: operationHash, retryCount: 0, hindsightStatus: status });
  };
  return { root, pending, stateDatabase, state, run, write, pair, record };
}

function totals(files: number) { return { files, bytes: files * Buffer.byteLength(payload) }; }

void test("spool cleanup previews counts without changes and applies only to terminal payloads", async (t) => {
  const f = await fixture(t);
  f.record("superseded", "failed");
  f.record("excluded", "cancelled", { state: "excluded" });
  f.record("completed", "completed", { state: "completed" });
  await Promise.all([f.pair("superseded"), f.pair("excluded"), f.pair("completed")]);
  const files = (await fs.readdir(f.pending)).sort();
  const generations = f.state.listGenerations();
  const preview = await f.run();
  assert.deepEqual(JSON.parse(preview.stdout), { apply: false, eligible: totals(6), kept: totals(0), removed: totals(0) });
  assert.deepEqual((await fs.readdir(f.pending)).sort(), files);
  for (const file of files) assert.equal(await fs.readFile(path.join(f.pending, file), "utf8"), payload);
  assert.deepEqual(f.state.listGenerations(), generations);
  const applied = await f.run("--apply");
  assert.deepEqual(JSON.parse(applied.stdout), { apply: true, eligible: totals(6), kept: totals(0), removed: totals(6) });
  assert.deepEqual(await fs.readdir(f.pending), []);
  assert.deepEqual(f.state.listGenerations(), generations);
});

void test("spool cleanup retains pending, retryable, unresolved, and repair payloads", async (t) => {
  const f = await fixture(t);
  f.record("pending", "pending");
  f.record("retryable", "failed", { state: "failed" });
  f.record("queued", "failed", { state: "queued" });
  f.record("held", UNRESOLVED_SUBMISSION);
  f.record("quarantined", "failed", { error: STALE_REDACTION_PAYLOAD });
  f.record("repair", "completed", { state: "completed", repair: true });
  f.record("not-submitted", "not_submitted");
  f.record("no-operation", undefined);
  f.record("hash-mismatch", "failed", {}, "different-hash");
  f.record("cleanup-job", "failed");
  f.state.upsertCleanupJob({ jobId: "job", action: "delete-document", targetKind: "subagent", source: "pi", nativeSessionId: "cleanup-job", documentId: "agent-session:pi:cleanup-job", oldOperationId: "cleanup-job", phase: "planned", createdAt: queuedAt, updatedAt: queuedAt });
  await Promise.all(f.state.listGenerations().map((g) => f.pair(g.operationId)));
  const files = (await fs.readdir(f.pending)).sort();
  const result = await f.run("--apply");
  assert.deepEqual(JSON.parse(result.stdout), { apply: true, eligible: totals(0), kept: totals(files.length), removed: totals(0) });
  assert.deepEqual((await fs.readdir(f.pending)).sort(), files);
});

void test("spool cleanup handles interrupted publication and leaves unproven partial files", async (t) => {
  const f = await fixture(t);
  f.record("text-only", "failed");
  f.record("metadata-only", "completed");
  f.record("terminal-temp", "failed");
  f.record("active", "ready", { state: "queued" });
  f.record("changed-after-preview", "failed");
  f.record("link", "failed");
  const keep = ["active.jsonl", "active.json.tmp", "orphan.jsonl.tmp", "unrecorded.jsonl"];
  const remove = ["text-only.jsonl", "metadata-only.json", "terminal-temp.jsonl.tmp", "changed-after-preview.jsonl"];
  await Promise.all([...keep, ...remove].map(f.write));
  const target = path.join(f.root, "outside-spool");
  await fs.writeFile(target, payload);
  await fs.symlink(target, path.join(f.pending, "link.jsonl"));
  const preview = await f.run();
  assert.equal(JSON.parse(preview.stdout).eligible.files, remove.length);
  f.state.setGenerationState("pi", "changed-after-preview", "hash", "queued");
  const applied = await f.run("--apply");
  assert.deepEqual(JSON.parse(applied.stdout), { apply: true, eligible: totals(3), kept: totals(5), removed: totals(3) });
  assert.deepEqual((await fs.readdir(f.pending)).sort(), [...keep, "changed-after-preview.jsonl", "link.jsonl"].sort());
  assert.equal(await fs.readFile(target, "utf8"), payload);
  assert.equal((await fs.lstat(path.join(f.pending, "link.jsonl"))).isSymbolicLink(), true);
  const repeated = await f.run("--apply");
  assert.deepEqual(JSON.parse(repeated.stdout).removed, totals(0));
});

void test("spool cleanup preview and apply require the importer writer lock", async (t) => {
  const f = await fixture(t);
  f.record("superseded", "failed");
  await f.pair("superseded");
  await withWriterLock(f.stateDatabase, async () => {
    await assert.rejects(f.run(), /writer lock is busy/);
    await assert.rejects(f.run("--apply"), /writer lock is busy/);
  });
  assert.deepEqual((await fs.readdir(f.pending)).sort(), ["superseded.json", "superseded.jsonl"]);
});
