import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { documentIdFor, operationIdFor } from "../../src/common/hashing.js";
import type { HindsightClient } from "../../src/hindsight/client.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { verifyFullImport } from "../../src/importer/verify.js";

function fakeClient(documentId: string, pendingConsolidation: number, autoConsolidation: boolean, validBank = true, failedOperations = 0): HindsightClient {
  return {
    listDocuments: async () => [{ id: documentId, content_hash: "hash" }],
    getBankStats: async () => ({ pending_consolidation: pendingConsolidation, failed_consolidation: 0, pending_operations: 0, failed_operations: failedOperations, operations_by_status: {} }),
    getBankConfig: async () => ({ config: { enable_auto_consolidation: autoConsolidation } }),
    assertExtractionAvailable: async () => undefined,
    assertBankConfiguration: async () => {
      if (!validBank) throw new Error("invalid production bank");
      return {};
    },
  } as unknown as HindsightClient;
}

test("readiness requires exact documents, idle Hindsight, and continuous consolidation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-readiness-"));
  const config = defaultConfig(root);
  config.stateDatabase = path.join(root, "state.sqlite3");
  const documentId = documentIdFor("pi", "ready-session");
  const state = new StateDatabase(config.stateDatabase);
  state.upsertSession({
    source: "pi", nativeSessionId: "ready-session", documentId, sourceLocator: "/synthetic/session.jsonl",
    sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "a", stableLocator: "/synthetic/session.jsonl" },
    canonicalHash: "hash", canonicalBytes: 1, canonicalTurns: 1, canonicalSchema: "agent-session-v1",
    sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.000Z",
    status: "imported", lastSeenAt: "2026-01-01T00:00:00.000Z", classification: { kind: "primary", reason: "test", policyVersion: "2" },
  });
  state.upsertGeneration({ source: "pi", nativeSessionId: "ready-session", canonicalHash: "hash", operationId: operationIdFor("coding-history", documentId, "hash"), state: "completed", queuedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z", attemptCount: 1 });
  state.heartbeat("idle");
  state.close();
  try {
    const pending = await verifyFullImport(config, fakeClient(documentId, 1, true));
    assert.equal(pending.idempotencyReady, false);
    assert.equal(pending.continuousReady, false);
    const invalidBank = await verifyFullImport(config, fakeClient(documentId, 0, false, false));
    assert.equal(invalidBank.idempotencyReady, false);
    assert.equal(invalidBank.bankConfigurationReady, false);
    const bulkReady = await verifyFullImport(config, fakeClient(documentId, 0, false));
    assert.equal(bulkReady.idempotencyReady, true);
    assert.equal(bulkReady.continuousReady, false);
    const ready = await verifyFullImport(config, fakeClient(documentId, 0, true));
    assert.equal(ready.idempotencyReady, true);
    assert.equal(ready.continuousReady, true);
    const recovered = await verifyFullImport(config, fakeClient(documentId, 0, true, true, 42));
    assert.equal(recovered.failedHindsightOperations, 42);
    assert.equal(recovered.hindsightIdle, true);
    assert.equal(recovered.continuousReady, true);
    const wrongHash = fakeClient(documentId, 0, true, true, 42);
    wrongHash.listDocuments = async () => [{ id: documentId, content_hash: "wrong" }];
    assert.equal((await verifyFullImport(config, wrongHash)).activationReady, false);
    const failedConsolidation = fakeClient(documentId, 0, true, true, 42);
    failedConsolidation.getBankStats = async () => ({ failed_operations: 42, failed_consolidation: 1 });
    assert.equal((await verifyFullImport(config, failedConsolidation)).activationReady, false);
    const stoppedState = new StateDatabase(config.stateDatabase);
    stoppedState.upsertGeneration({ source: "pi", nativeSessionId: "ready-session", canonicalHash: "failed-update", operationId: "failed-op", state: "failed", queuedAt: "2026-01-02T00:00:00.000Z", attemptCount: 3 });
    const unresolved = await verifyFullImport(config, fakeClient(documentId, 0, true, true, 42));
    assert.equal(unresolved.failedGenerations, 1);
    assert.equal(unresolved.activationReady, false);
    stoppedState.setGenerationState("pi", "ready-session", "failed-update", "superseded");
    stoppedState.heartbeat("stopped");
    stoppedState.close();
    const stopped = await verifyFullImport(config, fakeClient(documentId, 0, true));
    assert.equal(stopped.activationReady, true);
    assert.equal(stopped.continuousReady, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
