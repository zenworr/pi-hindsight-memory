import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { operationIdFor } from "../../src/common/hashing.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { ImportWorker } from "../../src/importer/worker.js";
import { StateDatabase } from "../../src/importer/state-db.js";

test("worker reclassifies a queued modern Pi child before retain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-worker-child-"));
  const sourcePath = path.join(root, "agent.jsonl");
  await fs.writeFile(sourcePath, '{"type":"session","version":3,"id":"modern-child","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n{"type":"session_info","name":"advisor#deadbeef","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  const config = defaultConfig(root);
  config.stateDirectory = path.join(root, "state");
  config.stateDatabase = ":memory:";
  config.spoolDirectory = path.join(root, "spool");
  config.sourceRoots.pi = root;
  config.sourceRoots.codex = path.join(root, "none-codex");
  config.sourceRoots.claude = path.join(root, "none-claude");
  config.opencodeDatabase = path.join(root, "none-opencode.db");
  config.requireImportApproval = false;
  const state = new StateDatabase(":memory:");
  state.upsertSession({ source: "pi", nativeSessionId: "modern-child", documentId: "agent-session:pi:modern-child", sourceLocator: sourcePath, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: sourcePath }, canonicalHash: "queued-hash", canonicalBytes: 1, canonicalTurns: 1, canonicalSchema: "agent-session-v1", sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.001Z", status: "discovered", lastSeenAt: new Date().toISOString() });
  state.upsertGeneration({ source: "pi", nativeSessionId: "modern-child", canonicalHash: "queued-hash", operationId: operationIdFor(config.hindsight.bankId, "agent-session:pi:modern-child", "queued-hash"), state: "queued", queuedAt: new Date().toISOString(), attemptCount: 0 });
  let retainCalls = 0;
  const fakeClient = { ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined, retainWithOperationId: async () => { retainCalls += 1; return {}; } };
  try {
    const result = await new ImportWorker(config, state, fakeClient as any).runOnce(1);
    assert.equal(result.deferred, 1);
    assert.equal(retainCalls, 0);
    assert.equal(state.getSession("pi", "modern-child")?.classification?.kind, "subagent");
    assert.equal(state.getSession("pi", "modern-child")?.status, "excluded_subagent");
    assert.equal(state.getGeneration("pi", "modern-child", "queued-hash")?.state, "cleanup_pending");
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("worker never submits two mutable generations for one document at once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-worker-"));
  const sourcePath = path.join(root, "session.jsonl");
  await fs.copyFile(path.resolve("test/fixtures/pi/session.jsonl"), sourcePath);
  const config = defaultConfig(root);
  config.stateDirectory = path.join(root, "state");
  config.stateDatabase = ":memory:";
  config.spoolDirectory = path.join(root, "spool");
  config.sourceRoots.pi = root;
  config.sourceRoots.codex = path.join(root, "none-codex");
  config.sourceRoots.claude = path.join(root, "none-claude");
  config.opencodeDatabase = path.join(root, "none-opencode.db");
  config.maxInflightDocuments = 2;
  config.requireImportApproval = false;
  const adapter = new PiAdapter(root);
  let reference: any;
  for await (const candidate of adapter.discover()) if (candidate.nativeSessionId === "pi-fixture-001") reference = candidate;
  assert.ok(reference);
  const canonical = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: 10_000_000 });
  const state = new StateDatabase(":memory:");
  state.upsertSession({ source: "pi", nativeSessionId: "pi-fixture-001", documentId: canonical.documentId, sourceLocator: sourcePath, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: sourcePath }, canonicalHash: canonical.canonicalHash, canonicalBytes: canonical.canonicalBytes, canonicalTurns: canonical.canonicalTurns, canonicalSchema: "agent-session-v1", sessionStartedAt: canonical.sessionStartedAt, sessionUpdatedAt: canonical.sessionUpdatedAt, status: "discovered", lastSeenAt: new Date().toISOString() });
  await canonical.cleanup();
  const first = { source: "pi" as const, nativeSessionId: "pi-fixture-001", canonicalHash: "hash-first", operationId: operationIdFor(config.hindsight.bankId, canonical.documentId, "hash-first"), state: "queued" as const, queuedAt: "2026-01-01T00:00:00.000Z", attemptCount: 0 };
  // The current source hash is used for the only generation that can complete. The second
  // generation is newer in queue order but deliberately cannot match the current source snapshot.
  first.canonicalHash = canonical.canonicalHash;
  first.operationId = operationIdFor(config.hindsight.bankId, canonical.documentId, first.canonicalHash);
  const second = { source: "pi" as const, nativeSessionId: "pi-fixture-001", canonicalHash: "hash-second", operationId: operationIdFor(config.hindsight.bankId, canonical.documentId, "hash-second"), state: "queued" as const, queuedAt: "2026-01-01T00:01:00.000Z", attemptCount: 0 };
  state.upsertGeneration(first); state.upsertGeneration(second);
  let retainCalls = 0;
  const bankChecks: Array<{ bulk?: boolean }> = [];
  const fakeClient = {
    ensureBank: async () => undefined,
    assertBankConfiguration: async (options: { bulk?: boolean }) => {
      bankChecks.push(options);
      if (options.bulk) throw new Error("auto-consolidation must remain available for continuous imports");
      return {};
    },
    assertExtractionAvailable: async () => undefined,
    retainWithOperationId: async () => { retainCalls += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { operation_id: first.operationId }; },
    waitForOperation: async () => ({ status: "completed" }),
  };
  const worker = new ImportWorker(config, state, fakeClient as any);
  const result = await worker.runOnce(2);
  assert.equal(result.completed, 1);
  assert.equal(result.deferred, 1);
  assert.equal(retainCalls, 1);
  assert.deepEqual(bankChecks.map((check) => check.bulk), [false]);
  assert.equal(state.getGeneration("pi", "pi-fixture-001", "hash-second")?.state, "queued");
  state.close();
  await fs.rm(root, { recursive: true, force: true });
});
