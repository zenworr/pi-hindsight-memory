import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PiAdapter } from "../../src/adapters/pi.js";
import { createAdapters } from "../../src/adapters/index.js";
import { defaultConfig } from "../../src/common/config.js";
import { scan } from "../../src/importer/scanner.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";
import { importerHealth } from "../../src/importer/health.js";
import { HOUR_MS } from "../../src/common/limits.js";
import type { CanonicalSession } from "../../src/common/types.js";

const fixture = path.join(import.meta.dirname, "../../..", "test/fixtures/pi/session.jsonl");

async function first<T>(values: AsyncIterable<T>): Promise<T | undefined> {
  for await (const value of values) return value;
  return undefined;
}

test("desktop feed age is reported even when importer scans still succeed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-age-"));
  const state = new StateDatabase(path.join(root, "state.sqlite3"));
  try {
    const feed = path.join(root, "current");
    fs.mkdirSync(feed);
    const config = defaultConfig(root);
    config.desktopFeed = { enabled: true, directory: feed, sourceHome: root };
    fs.writeFileSync(path.join(feed, "manifest.json"), JSON.stringify({ completedAt: "2020-01-01T00:00:00Z" }));
    assert.equal(importerHealth(config, state.db).desktopFeedStale, true);
    fs.writeFileSync(path.join(feed, "manifest.json"), JSON.stringify({ completedAt: new Date(Date.now() - HOUR_MS).toISOString() }));
    assert.equal(importerHealth(config, state.db).desktopFeedStale, false);
    fs.writeFileSync(path.join(feed, "manifest.json"), JSON.stringify({ completedAt: new Date().toISOString() }));
    assert.equal(importerHealth(config, state.db).desktopFeedStale, false);
    fs.unlinkSync(path.join(feed, "manifest.json"));
    assert.equal(importerHealth(config, state.db).desktopFeedStale, true);
  } finally { state.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a completed desktop feed keeps the original Pi identity and canonical content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-adapter-"));
  try {
    const originalHome = path.join(root, "desktop");
    const devHome = path.join(root, "dev");
    const original = path.join(originalHome, ".pi/agent/sessions");
    const feed = path.join(root, "feed");
    const generation = path.join(feed, "generations", "gen-0001");
    const mirrored = path.join(generation, "pi");
    for (const dir of [original, mirrored]) fs.mkdirSync(dir, { recursive: true });
    const originalFile = path.join(original, "session.jsonl");
    fs.copyFileSync(fixture, originalFile);
    fs.copyFileSync(fixture, path.join(mirrored, "session.jsonl"));
    fs.writeFileSync(path.join(generation, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0001" }));
    fs.symlinkSync(path.join("generations", "gen-0001"), path.join(feed, "current"));
    const config = defaultConfig(devHome);
    config.localOrigin = "dev";
    config.desktopFeed = { enabled: true, directory: path.join(feed, "current"), sourceHome: originalHome };
    const adapter = createAdapters(config).find((item) => item.source === "pi" && item.origin === "desktop");
    assert.ok(adapter);
    const reference = await first(adapter.discover());
    assert.ok(reference);
    assert.equal(reference.origin, "desktop");
    assert.equal(reference.metadata.source_path, originalFile);
    assert.equal(reference.logicalLocator, originalFile);
    const baseline = new PiAdapter(original);
    const baselineReference = await first(baseline.discover());
    assert.ok(baselineReference);
    assert.equal(reference.nativeSessionId, baselineReference.nativeSessionId);
    const current = await adapter.fingerprint(reference);
    const previous = await baseline.fingerprint(baselineReference);
    assert.equal(current.stableLocator, previous.stableLocator);
    assert.equal(current.sampleHash, previous.sampleHash);
    const [session, oldSession] = await Promise.all([
      adapter.load(reference, { spoolDirectory: path.join(root, "spool-new"), maxCanonicalBytes: 10_000_000 }),
      baseline.load(baselineReference, { spoolDirectory: path.join(root, "spool-old"), maxCanonicalBytes: 10_000_000 }),
    ]);
    try {
      assert.equal(session.canonicalHash, oldSession.canonicalHash);
      assert.equal(session.metadata.source_path, originalFile);
      assert.equal(session.documentId, oldSession.documentId);
    } finally { await session.cleanup(); await oldSession.cleanup(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a single state owner scans distinct desktop and dev sessions with origin labels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-owner-"));
  const state = new StateDatabase(path.join(root, "state", "state.sqlite3"));
  try {
    const originalHome = path.join(root, "desktop");
    const devHome = path.join(root, "dev");
    const devSessions = path.join(devHome, ".pi/agent/sessions");
    const generation = path.join(root, "feed/generations/gen-0001");
    const mirrored = path.join(generation, "pi");
    for (const dir of [devSessions, mirrored]) fs.mkdirSync(dir, { recursive: true });
    const devSession = fs.readFileSync(fixture, "utf8").replace("pi-fixture-001", "pi-fixture-dev");
    fs.writeFileSync(path.join(devSessions, "session.jsonl"), devSession);
    fs.copyFileSync(fixture, path.join(mirrored, "session.jsonl"));
    fs.writeFileSync(path.join(generation, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0001" }));
    fs.symlinkSync(path.join("generations", "gen-0001"), path.join(root, "feed/current"));
    const config = defaultConfig(devHome);
    config.stateDirectory = path.join(root, "state");
    config.stateDatabase = state.databasePath;
    config.evidenceDatabase = path.join(root, "state", "evidence.sqlite3");
    config.spoolDirectory = path.join(root, "spool");
    config.localOrigin = "dev";
    config.desktopFeed = { enabled: true, directory: path.join(root, "feed/current"), sourceHome: originalHome };
    config.requireImportApproval = false;
    const summary = await scan(config, state, { source: "pi", force: true });
    assert.equal(summary.errors, 0);
    assert.equal(summary.sourceMissing, 0);
    assert.deepEqual(state.listSessions("pi").map((entry) => [entry.nativeSessionId, entry.sourceOrigin]), [
      ["pi-fixture-001", "desktop"], ["pi-fixture-dev", "dev"],
    ]);
    const paths: string[] = [];
    const client = {
      ensureBank: async () => undefined,
      assertBankConfiguration: async () => ({}),
      assertExtractionAvailable: async () => undefined,
      retainWithOperationId: async (session: CanonicalSession, operationId: string) => {
        paths.push(session.metadata.source_path);
        return { operation_id: operationId };
      },
      waitForOperation: async () => ({ status: "completed" }),
    };
    const work = await new ImportWorker(config, state, client as any).runOnce(2);
    assert.equal(work.completed, 2);
    assert.deepEqual(paths.sort(), [path.join(originalHome, ".pi/agent/sessions/session.jsonl"), path.join(devSessions, "session.jsonl")].sort());
  } finally { state.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("new feed generations reuse stable artifact and alias locators", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-rotate-"));
  const state = new StateDatabase(path.join(root, "state", "state.sqlite3"));
  try {
    const originalHome = path.join(root, "desktop");
    const devHome = path.join(root, "dev");
    const feed = path.join(root, "feed");
    const gen1 = path.join(feed, "generations/gen-0001");
    fs.mkdirSync(path.join(gen1, "pi"), { recursive: true });
    fs.mkdirSync(path.join(devHome, ".pi/agent/sessions"), { recursive: true });
    fs.copyFileSync(fixture, path.join(gen1, "pi/session.jsonl"));
    fs.writeFileSync(path.join(gen1, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0001" }));
    fs.symlinkSync("generations/gen-0001", path.join(feed, "current"));
    const config = defaultConfig(devHome);
    config.localOrigin = "dev";
    config.desktopFeed = { enabled: true, directory: path.join(feed, "current"), sourceHome: originalHome };
    config.stateDirectory = path.join(root, "state");
    config.evidenceDatabase = path.join(root, "state", "evidence.sqlite3");
    config.spoolDirectory = path.join(root, "spool");
    const firstScan = await scan(config, state, { source: "pi", force: true });
    assert.equal(firstScan.queued, 1);
    const completed = state.getLatestGeneration("pi", "pi-fixture-001")!;
    state.setGenerationState("pi", "pi-fixture-001", completed.canonicalHash, "completed");
    const gen2 = path.join(feed, "generations/gen-0002");
    fs.mkdirSync(path.join(gen2, "pi"), { recursive: true });
    fs.linkSync(path.join(gen1, "pi/session.jsonl"), path.join(gen2, "pi/session.jsonl"));
    fs.writeFileSync(path.join(gen2, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0002" }));
    fs.symlinkSync("generations/gen-0002", path.join(feed, ".current-next"));
    fs.renameSync(path.join(feed, ".current-next"), path.join(feed, "current"));
    const secondScan = await scan(config, state, { source: "pi" });
    assert.equal(secondScan.unchanged, 1);
    assert.equal(secondScan.queued, 0);
    assert.equal((state.db.prepare("SELECT count(*) AS count FROM session_artifacts").get() as { count: number }).count, 1);
    assert.equal((state.db.prepare("SELECT count(*) AS count FROM session_aliases").get() as { count: number }).count, 1);
    assert.equal(state.getSession("pi", "pi-fixture-001")?.sourceLocator, path.join(feed, "current/pi/session.jsonl"));
  } finally { state.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a reviewed handoff changes one session owner without a second generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-handoff-"));
  const state = new StateDatabase(path.join(root, "state", "state.sqlite3"));
  try {
    const originalHome = path.join(root, "desktop");
    const devHome = path.join(root, "dev");
    const devSessions = path.join(devHome, ".pi/agent/sessions");
    const generation = path.join(root, "feed/generations/gen-0001");
    const mirrored = path.join(generation, "pi");
    for (const dir of [devSessions, mirrored]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixture, path.join(mirrored, "session.jsonl"));
    fs.writeFileSync(path.join(generation, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0001" }));
    fs.symlinkSync(path.join("generations", "gen-0001"), path.join(root, "feed/current"));
    const config = defaultConfig(devHome);
    config.stateDirectory = path.join(root, "state");
    config.stateDatabase = state.databasePath;
    config.evidenceDatabase = path.join(root, "state", "evidence.sqlite3");
    config.spoolDirectory = path.join(root, "spool");
    config.localOrigin = "dev";
    config.desktopFeed = { enabled: true, directory: path.join(root, "feed/current"), sourceHome: originalHome };
    const firstScan = await scan(config, state, { source: "pi", force: true });
    assert.equal(firstScan.queued, 1);
    assert.equal(state.getSession("pi", "pi-fixture-001")?.sourceOrigin, "desktop");
    const imported = state.getLatestGeneration("pi", "pi-fixture-001")!;
    state.setGenerationState("pi", "pi-fixture-001", imported.canonicalHash, "completed");
    config.promotedSessions.pi = ["pi-fixture-001"];
    await assert.rejects(scan(config, state, { source: "pi", force: true }), /is absent from dev/);
    assert.equal(state.getSession("pi", "pi-fixture-001")?.sourceOrigin, "desktop");
    fs.copyFileSync(fixture, path.join(devSessions, "session.jsonl"));
    const moved = await scan(config, state, { source: "pi", force: true });
    assert.equal(moved.queued, 0);
    assert.equal(moved.sourceMissing, 0);
    assert.equal(state.getSession("pi", "pi-fixture-001")?.sourceOrigin, "dev");
  } finally { state.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("two origins with the same native session ID are rejected before state changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-feed-conflict-"));
  const state = new StateDatabase(":memory:");
  try {
    const originalHome = path.join(root, "desktop");
    const devHome = path.join(root, "dev");
    const devSessions = path.join(devHome, ".pi/agent/sessions");
    const generation = path.join(root, "feed/generations/gen-0001");
    const mirrored = path.join(generation, "pi");
    for (const dir of [devSessions, mirrored]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(fixture, path.join(devSessions, "session.jsonl"));
    fs.copyFileSync(fixture, path.join(mirrored, "session.jsonl"));
    fs.writeFileSync(path.join(generation, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: originalHome, generation: "gen-0001" }));
    fs.symlinkSync(path.join("generations", "gen-0001"), path.join(root, "feed/current"));
    const config = defaultConfig(devHome);
    config.localOrigin = "dev";
    config.desktopFeed = { enabled: true, directory: path.join(root, "feed/current"), sourceHome: originalHome };
    await assert.rejects(scan(config, state, { source: "pi", force: true }), /Duplicate pi session pi-fixture-001/);
    assert.equal((state.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count, 0);
    assert.equal((state.db.prepare("SELECT COUNT(*) AS count FROM sources").get() as { count: number }).count, 0);
    assert.equal((state.db.prepare("SELECT COUNT(*) AS count FROM session_artifacts").get() as { count: number }).count, 0);
  } finally { state.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
