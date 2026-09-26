import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { runDaemon } from "../../src/importer/daemon.js";
import { importerHealth } from "../../src/importer/health.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "daemon did not reach the expected state");
    await delay(10);
  }
}

test("daemon retries failures before the full scan interval and clears recovered queue errors immediately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-daemon-"));
  const config = defaultConfig(root);
  config.scanIntervalSeconds = 3600;
  config.opencodeDatabase = path.join(root, "opencode.db");
  const opencode = new DatabaseSync(config.opencodeDatabase);
  opencode.exec("CREATE TABLE session(id TEXT, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)");
  opencode.close();
  const state = new StateDatabase(config.stateDatabase);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  let preflights = 0;
  let queueFails = false;
  let batches = 0;
  t.mock.method(ImportWorker.prototype, "preflight", async () => {
    if (++preflights === 1) throw new Error("temporary network failure");
  });
  t.mock.method(ImportWorker.prototype, "runOnce", async () => {
    batches++;
    if (queueFails) throw new Error("temporary queue failure");
    state.db.exec("UPDATE generations SET state='superseded' WHERE state='queued'");
    return { selected: 0, completed: 0, failed: 0, deferred: 0 };
  });
  t.mock.method(HindsightClient.prototype, "listDocuments", async () => []);
  t.mock.method(HindsightClient.prototype, "getBankStats", async () => ({ failed_operations: 42 }));
  t.mock.method(HindsightClient.prototype, "getBankConfig", async () => ({ config: { enable_auto_consolidation: true } }));
  t.mock.method(HindsightClient.prototype, "assertBankConfiguration", async () => ({}));
  t.mock.method(HindsightClient.prototype, "assertExtractionAvailable", async () => undefined);
  const daemon = runDaemon(config);
  try {
    await until(() => importerHealth(config).lastError === "temporary network failure");
    // Allow the loop to install its timer after publishing the heartbeat.
    await setImmediate();
    t.mock.timers.tick(29_000);
    await setImmediate();
    assert.equal(preflights, 1);
    t.mock.timers.tick(1000);
    await until(() => batches === 1 && importerHealth(config).phase === "idle");
    assert.equal(importerHealth(config).lastError, undefined);
    const scanAt = state.db.prepare("SELECT last_scan_completed_at FROM sources LIMIT 1").get();

    state.upsertSession({ source: "pi", nativeSessionId: "queue", documentId: "queue", sourceLocator: "/fixture", sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "h", stableLocator: "/fixture" }, status: "discovered", lastSeenAt: new Date().toISOString() });
    state.upsertGeneration({ source: "pi", nativeSessionId: "queue", canonicalHash: "hash", operationId: "op", state: "queued", queuedAt: new Date().toISOString(), attemptCount: 0 });
    queueFails = true;
    await setImmediate();
    t.mock.timers.tick(1000);
    await until(() => importerHealth(config).lastError === "temporary queue failure");
    queueFails = false;
    await setImmediate();
    t.mock.timers.tick(30_000);
    await until(() => batches === 3 && importerHealth(config).phase === "idle");
    assert.equal(importerHealth(config).lastError, undefined);
    assert.deepEqual(state.db.prepare("SELECT last_scan_completed_at FROM sources LIMIT 1").get(), scanAt, "queue recovery must not rescan unchanged sources");
  } finally {
    process.emit("SIGTERM");
    await daemon;
    t.mock.timers.reset();
    state.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
