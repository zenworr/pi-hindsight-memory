import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { documentIdFor, operationIdFor } from "../../src/common/hashing.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { verifyFullImport } from "../../src/importer/verify.js";

function fakeClient(documentId: string, pendingConsolidation: number, autoConsolidation: boolean, validBank = true): HindsightClient {
  return {
    listDocumentIds: async () => new Set([documentId]),
    getBankStats: async () => ({ pending_consolidation: pendingConsolidation, failed_consolidation: 0, pending_operations: 0, failed_operations: 0, operations_by_status: {} }),
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
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
