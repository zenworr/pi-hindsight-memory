import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import type { DiscoveryOptions } from "../../src/adapters/adapter.js";
import type { SessionReference } from "../../src/common/types.js";
import { importerHealth } from "../../src/importer/health.js";
import { runInventory } from "../../src/importer/inventory.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { scan } from "../../src/importer/scanner.js";

async function configFor(root: string) {
  const config = defaultConfig(root);
  config.stateDirectory = path.join(root, "state");
  config.stateDatabase = path.join(root, "state", "state.sqlite3");
  config.reportDirectory = path.join(root, "state", "reports");
  config.spoolDirectory = path.join(root, "state", "canonical");
  config.sessionSettleSeconds = 0;
  config.sourceRoots.pi = path.join(root, "pi");
  config.sourceRoots.codex = path.join(root, "codex");
  config.sourceRoots.claude = path.join(root, "claude");
  config.sourceRoots.opencode = path.join(root, "opencode.db");
  return config;
}

const piFixture = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "u-1", message: { role: "user", content: "Synthetic session" } })}\n`;

test("scanner and inventory report a malformed first Pi header and discover later files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-scan-bad-header-"));
  const config = await configFor(root);
  const state = new StateDatabase(config.stateDatabase);
  try {
    await fs.mkdir(config.sourceRoots.pi);
    const bad = path.join(config.sourceRoots.pi, "a-invalid.jsonl");
    await fs.writeFile(bad, "not JSON\n");
    for (const id of ["b-valid", "c-valid"]) await fs.writeFile(path.join(config.sourceRoots.pi, `${id}.jsonl`), piFixture(id));
    const result = await scan(config, state, { source: "pi" });
    assert.equal(result.discovered, 3);
    assert.equal(result.errors, 1);
    assert.equal(result.queued, 2);
    assert.deepEqual(state.listSessions("pi").map((session) => session.nativeSessionId), ["b-valid", "c-valid"]);
    assert.deepEqual(state.db.prepare("SELECT locator FROM scan_errors").all().map((row) => row.locator), [bad]);
    assert.equal(result.results.find((entry) => entry.locator === bad)?.status, "malformed");
    const inventory = await runInventory(config, { source: "pi" });
    assert.equal(inventory.totals.malformed, 1);
    assert.equal(inventory.totals.eligible, 2);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner records per-reference classification errors and continues", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-scan-classification-"));
  const config = await configFor(root);
  const state = new StateDatabase(config.stateDatabase);
  const original = new PiAdapter(config.sourceRoots.pi);
  const discover = original.discover.bind(original);
  const classify = original.classify.bind(original);
  t.mock.method(PiAdapter.prototype, "discover", async function* (options?: DiscoveryOptions) {
    for await (const ref of discover(options)) yield { ...ref, classification: undefined };
  });
  t.mock.method(PiAdapter.prototype, "classify", (ref: SessionReference) => {
    if (ref.nativeSessionId === "a-broken") throw new Error("Cannot classify source");
    return classify(ref);
  });
  try {
    await fs.mkdir(config.sourceRoots.pi);
    for (const id of ["a-broken", "b-valid"]) await fs.writeFile(path.join(config.sourceRoots.pi, `${id}.jsonl`), piFixture(id));
    const result = await scan(config, state, { source: "pi" });
    assert.equal(result.errors, 1);
    assert.equal(result.queued, 1);
    assert.ok(state.db.prepare("SELECT 1 FROM scan_errors WHERE locator=?").get(path.join(config.sourceRoots.pi, "a-broken.jsonl")));
    assert.equal(state.listSessions("pi")[0]?.nativeSessionId, "b-valid");
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("only a complete healthy scan clears vanished settling candidates and orphan tracking rows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-scan-missing-candidate-"));
  const config = await configFor(root);
  config.sessionSettleSeconds = 3_600;
  const state = new StateDatabase(config.stateDatabase);
  try {
    await fs.mkdir(config.sourceRoots.pi);
    for (const id of ["settling", "legacy"]) await fs.writeFile(path.join(config.sourceRoots.pi, `${id}.jsonl`), piFixture(id));
    assert.equal((await scan(config, state, { source: "pi" })).active, 2);
    assert.equal(state.listSessions().length, 0);
    state.db.prepare("UPDATE scan_candidates SET source_origin=NULL WHERE native_session_id='legacy'").run();
    for (const id of ["settling", "legacy"]) await fs.rm(path.join(config.sourceRoots.pi, `${id}.jsonl`));
    for (const options of [{ limit: 1 }, { offset: 0 }, { sessionIds: ["settling"] }, { inventoryOnly: true }]) {
      await scan(config, state, { source: "pi", ...options });
      assert.equal(importerHealth(config, state.db).deferred, 2);
    }
    await fs.rmdir(config.sourceRoots.pi);
    await scan(config, state, { source: "pi" });
    assert.equal(importerHealth(config, state.db).deferred, 2);
    await fs.mkdir(config.sourceRoots.pi);
    await fs.writeFile(path.join(config.sourceRoots.pi, "broken.jsonl"), "not JSON\n");
    assert.equal((await scan(config, state, { source: "pi" })).errors, 1);
    assert.equal(importerHealth(config, state.db).deferred, 2);
    await fs.rm(path.join(config.sourceRoots.pi, "broken.jsonl"));
    const nested = path.join(config.sourceRoots.pi, "project");
    await fs.mkdir(nested);
    const readdir = fs.readdir.bind(fs);
    const incomplete = t.mock.method(fs, "readdir", (directory: string, options: { withFileTypes: true }) => directory === nested
      ? Promise.reject(Object.assign(new Error("Directory disappeared during enumeration"), { code: "ENOENT" })) : readdir(directory, options));
    assert.equal((await scan(config, state, { source: "pi" })).errors, 1);
    assert.equal(importerHealth(config, state.db).deferred, 2);
    assert.ok(state.db.prepare("SELECT 1 FROM scan_errors WHERE locator='<discovery>'").get());
    incomplete.mock.restore();
    assert.equal((await scan(config, state, { source: "pi" })).errors, 0);
    const health = importerHealth(config, state.db);
    assert.equal(health.deferred, 0);
    assert.equal(health.unprocessed, 0);
    assert.equal(health.scanErrors, 0);
    assert.deepEqual(state.listGenerations(), []);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner requires an unchanged observation window unless a scan is forced", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-settle-"));
  const config = await configFor(root);
  config.sessionSettleSeconds = 0.001;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await fs.writeFile(path.join(config.sourceRoots.pi, "session.jsonl"), '{"type":"session","version":3,"id":"active-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"message","id":"u-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"still active"}}\n', "utf8");
  const state = new StateDatabase(config.stateDatabase);
  try {
    const deferred = await scan(config, state, { source: "pi" });
    assert.equal(deferred.active, 1);
    assert.equal(deferred.queued, 0);
    assert.equal(state.listGenerations().length, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const settled = await scan(config, state, { source: "pi" });
    assert.equal(settled.active, 0);
    assert.equal(settled.queued, 1);

    await fs.appendFile(path.join(config.sourceRoots.pi, "session.jsonl"), '{"type":"message","id":"u-2","parentId":"u-1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":"changed again"}}\n');
    const changed = await scan(config, state, { source: "pi" });
    assert.equal(changed.active, 1);
    assert.equal(changed.queued, 0);
    const forced = await scan(config, state, { source: "pi", force: true });
    assert.equal(forced.active, 0);
    assert.equal(forced.queued, 1);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("unchanged empty sessions do not repeat settling, but changed empty sessions do", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-empty-settle-"));
  const config = await configFor(root);
  config.sessionSettleSeconds = 60;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const file = path.join(config.sourceRoots.pi, "session.jsonl");
  await fs.writeFile(file, '{"type":"session","version":3,"id":"empty-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n');
  const state = new StateDatabase(config.stateDatabase);
  try {
    const first = await scan(config, state, { source: "pi", force: true });
    assert.equal(first.empty, 1);
    for (let i = 0; i < 3; i++) {
      const result = await scan(config, state, { source: "pi" });
      assert.equal(result.active, 0);
      assert.equal(result.empty, 1);
      assert.equal(result.unchanged, 1);
      assert.equal(result.results[0]?.status, "empty_after_normalization");
      assert.equal(state.db.prepare("SELECT COUNT(*) AS n FROM scan_candidates").get()?.n, 0);
    }
    assert.equal(state.listGenerations().length, 0);
    await fs.appendFile(file, '{"type":"message","id":"u-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"New source evidence"}}\n');
    assert.equal((await scan(config, state, { source: "pi" })).active, 1);
    assert.equal((await scan(config, state, { source: "pi", force: true })).queued, 1);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner stops promptly when shutdown is requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-scan-abort-"));
  const config = await configFor(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await fs.writeFile(path.join(config.sourceRoots.pi, "session.jsonl"), '{"type":"session","version":3,"id":"abort-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n', "utf8");
  const state = new StateDatabase(config.stateDatabase);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(() => scan(config, state, { source: "pi", signal: controller.signal }), /abort/i);
    assert.equal(state.listGenerations().length, 0);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner excludes a configured session label before canonicalization or queueing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-exclusion-"));
  const config = await configFor(root);
  config.sessionExclusions.exactLabels = ["excluded-session"];
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const sourcePath = path.join(config.sourceRoots.pi, "session.jsonl");
  await fs.writeFile(sourcePath, '{"type":"session","version":3,"id":"excluded-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"session_info","name":"excluded-session","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n{"type":"message","id":"u-1","parentId":"info-1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Do not queue this session."}}\n', "utf8");
  const state = new StateDatabase(config.stateDatabase);
  try {
    const result = await scan(config, state, { source: "pi" });
    assert.equal(result.configured, 1);
    assert.equal(result.queued, 0);
    assert.equal(state.listGenerations().length, 0);
    assert.equal(state.listArtifacts("configured-exclusion").length, 1);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner quarantines modern Pi child sessions before canonicalization or queueing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-modern-child-"));
  const config = await configFor(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await fs.writeFile(path.join(config.sourceRoots.pi, "agent.jsonl"), '{"type":"session","version":3,"id":"agent-child","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n{"type":"session_info","name":"new-agent-kind#deadbeef","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n{"type":"message","id":"u-1","parentId":"info-1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"must never be canonicalized"}}\n', "utf8");
  await fs.writeFile(path.join(config.sourceRoots.pi, "fork.jsonl"), '{"type":"session","version":3,"id":"unknown-child","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n', "utf8");
  const state = new StateDatabase(config.stateDatabase);
  try {
    const result = await scan(config, state, { source: "pi" });
    assert.equal(result.excluded, 1);
    assert.equal(result.ambiguous, 1);
    assert.equal(result.queued, 0);
    assert.equal(state.listGenerations().length, 0);
    assert.equal(state.listArtifacts("subagent").length, 1);
    assert.equal(state.listArtifacts("ambiguous").length, 1);
    await assert.rejects(() => fs.access(config.spoolDirectory));
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner blocks reclassified subagents and preserves completed ambiguous forks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-reclassification-"));
  const config = await configFor(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const definitePath = path.join(config.sourceRoots.pi, "definite.jsonl");
  const ambiguousPath = path.join(config.sourceRoots.pi, "ambiguous.jsonl");
  const primary = (id: string) => `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"message","id":"u-1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"primary"}}\n`;
  await fs.writeFile(definitePath, primary("became-subagent"), "utf8");
  await fs.writeFile(ambiguousPath, primary("became-ambiguous"), "utf8");
  const state = new StateDatabase(config.stateDatabase);
  try {
    await scan(config, state, { source: "pi" });
    for (const id of ["became-subagent", "became-ambiguous"]) {
      const generation = state.getLatestGeneration("pi", id)!;
      state.setGenerationState("pi", id, generation.canonicalHash, "completed", { completedAt: new Date().toISOString() });
      state.setSessionStatus("pi", id, "imported");
    }
    await fs.writeFile(definitePath, '{"type":"session","version":3,"id":"became-subagent","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"parent"}\n{"type":"session_info","name":"advisor#deadbeef","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
    await fs.writeFile(ambiguousPath, '{"type":"session","version":3,"id":"became-ambiguous","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"parent"}\n', "utf8");
    await scan(config, state, { source: "pi" });
    assert.equal(state.getSession("pi", "became-subagent")?.status, "excluded_subagent");
    assert.equal(state.getLatestGeneration("pi", "became-subagent")?.state, "cleanup_pending");
    assert.equal(state.getSession("pi", "became-ambiguous")?.status, "ambiguous_preserved");
    assert.equal(state.getLatestGeneration("pi", "became-ambiguous")?.state, "completed");
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("scanner is idempotent, detects changed mutable sessions, and never deletes missing source documents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-scanner-"));
  const config = await configFor(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await fs.copyFile(path.resolve("test/fixtures/pi/session.jsonl"), path.join(config.sourceRoots.pi, "session.jsonl"));
  const state = new StateDatabase(config.stateDatabase);
  try {
    const first = await scan(config, state, { source: "pi" });
    assert.equal(first.discovered, 1);
    assert.equal(state.listGenerations().length, 1);
    const second = await scan(config, state, { source: "pi" });
    assert.equal(second.unchanged, 1);
    assert.equal(state.listGenerations().length, 1);
    await fs.appendFile(path.join(config.sourceRoots.pi, "session.jsonl"), '{"type":"message"', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scan(config, state, { source: "pi" });
    assert.equal(state.listGenerations().length, 1, "same canonical content must not create a generation duplicate");
    const sessionPath = path.join(config.sourceRoots.pi, "session.jsonl");
    const generation = state.listGenerations()[0]!;
    state.setGenerationState("pi", "pi-fixture-001", generation.canonicalHash, "completed", { completedAt: new Date().toISOString() });
    state.setSessionStatus("pi", "pi-fixture-001", "imported");
    await fs.rm(sessionPath);
    await scan(config, state, { source: "pi" });
    assert.equal(state.getSession("pi", "pi-fixture-001")?.status, "source_missing");
    await fs.copyFile(path.resolve("test/fixtures/pi/session.jsonl"), sessionPath);
    await scan(config, state, { source: "pi" });
    assert.equal(state.getSession("pi", "pi-fixture-001")?.status, "imported");
    assert.equal(state.listGenerations().length, 1);
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});
