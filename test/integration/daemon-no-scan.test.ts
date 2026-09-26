import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { runDaemon } from "../../src/importer/daemon.js";
import { importerHealth } from "../../src/importer/health.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";

test("continuous --no-scan processes queued work without discovering sources", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-no-scan-"));
  const config = defaultConfig(root);
  const state = new StateDatabase(config.stateDatabase);
  state.upsertSession({ source: "pi", nativeSessionId: "queue", documentId: "queue", sourceLocator: "/fixture", sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "h", stableLocator: "/fixture" }, status: "discovered", lastSeenAt: new Date().toISOString() });
  state.upsertGeneration({ source: "pi", nativeSessionId: "queue", canonicalHash: "hash", operationId: "op", state: "queued", queuedAt: new Date().toISOString(), attemptCount: 0 });
  t.mock.method(ImportWorker.prototype, "preflight", async () => undefined);
  t.mock.method(ImportWorker.prototype, "runOnce", async () => { state.db.exec("UPDATE generations SET state='superseded'"); return { selected: 1, completed: 0, failed: 0, deferred: 0 }; });
  t.mock.method(HindsightClient.prototype, "listDocuments", async () => []);
  t.mock.method(HindsightClient.prototype, "getBankStats", async () => ({}));
  t.mock.method(HindsightClient.prototype, "getBankConfig", async () => ({ config: { enable_auto_consolidation: true } }));
  t.mock.method(HindsightClient.prototype, "assertBankConfiguration", async () => ({}));
  t.mock.method(HindsightClient.prototype, "assertExtractionAvailable", async () => undefined);
  const daemon = runDaemon(config, { scanFirst: false });
  try {
    const end = Date.now() + 10_000;
    while (importerHealth(config).phase !== "idle") {
      assert.ok(Date.now() < end, "daemon did not become idle");
      await setTimeout(10);
    }
    assert.equal(state.pendingWorkCount(config.importer.maxAttempts), 0);
    assert.equal(state.db.prepare("SELECT count(*) AS count FROM sources").get()!.count, 0);
    assert.equal(importerHealth(config).scanErrors, 0);
  } finally {
    process.emit("SIGTERM");
    await daemon;
    state.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
