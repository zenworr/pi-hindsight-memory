import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
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
