import test from "node:test";
import assert from "node:assert/strict";
import { StateDatabase } from "../../src/importer/state-db.js";
import { operationIdFor, replayOperationIdFor, documentIdFor } from "../../src/common/hashing.js";

function sessionRow(id: string) {
  return {
    source: "pi" as const,
    nativeSessionId: id,
    documentId: documentIdFor("pi", id),
    sourceLocator: `/tmp/${id}.jsonl`,
    sourceSize: 10,
    sourceMtime: 1,
    sourceFingerprint: { size: 10, mtimeMs: 1, sampleHash: "abc", stableLocator: `/tmp/${id}.jsonl`, processing_signature: "v1" },
    canonicalHash: undefined,
    canonicalBytes: undefined,
    canonicalTurns: undefined,
    canonicalSchema: undefined,
    sessionStartedAt: "2026-01-01T00:00:00.000Z",
    sessionUpdatedAt: "2026-01-01T00:00:00.000Z",
    status: "discovered",
    lastSeenAt: new Date().toISOString(),
  };
}

test("UUIDv5 operation IDs are stable and distinct by document generation", () => {
  const first = operationIdFor("coding-history", "agent-session:pi:a", "hash-a");
  assert.equal(first, operationIdFor("coding-history", "agent-session:pi:a", "hash-a"));
  assert.notEqual(first, operationIdFor("coding-history", "agent-session:pi:a", "hash-b"));
  assert.match(first, /^[0-9a-f-]{36}$/);
});

test("state atomically serializes generations for one mutable document", () => {
  const state = new StateDatabase(":memory:");
  state.upsertSession(sessionRow("s1"));
  const first = { source: "pi" as const, nativeSessionId: "s1", canonicalHash: "hash-a", operationId: operationIdFor("coding-history", "agent-session:pi:s1", "hash-a"), state: "queued" as const, queuedAt: "2026-01-01T00:00:00.000Z", attemptCount: 0 };
  const second = { source: "pi" as const, nativeSessionId: "s1", canonicalHash: "hash-b", operationId: operationIdFor("coding-history", "agent-session:pi:s1", "hash-b"), state: "queued" as const, queuedAt: "2026-01-01T00:01:00.000Z", attemptCount: 0 };
  state.upsertGeneration(first); state.upsertGeneration(second);
  assert.equal(state.claimGeneration(first), true);
  assert.equal(state.claimGeneration(second), false);
  state.setGenerationState("pi", "s1", "hash-a", "completed", { completedAt: new Date().toISOString() });
  assert.equal(state.claimGeneration(second), true);
  assert.equal(state.getGeneration("pi", "s1", "hash-b")?.state, "processing");
  state.close();
});

test("budget reservations are idempotent and enforce approved limits", () => {
  const state = new StateDatabase(":memory:");
  assert.equal(state.reserveBudget("op-1", 100, 1, 500, 5), true);
  assert.equal(state.reserveBudget("op-1", 100, 1, 500, 5), true);
  assert.equal(state.budget().reservedInputTokens, 100);
  assert.equal(state.reserveBudget("op-2", 450, 5, 500, 5), false);
  state.close();
});

test("state blocks and finalizes excluded generations through the cleanup journal", () => {
  const state = new StateDatabase(":memory:");
  const session = { ...sessionRow("excluded"), classification: { kind: "configured-exclusion" as const, reason: "configured", policyVersion: "1", label: "excluded-session" }, status: "cleanup_pending" };
  state.upsertSession(session);
  const generation = { source: "pi" as const, nativeSessionId: "excluded", canonicalHash: "hash", operationId: operationIdFor("b", session.documentId, "hash"), state: "queued" as const, queuedAt: new Date().toISOString(), attemptCount: 0 };
  state.upsertGeneration(generation);
  state.planCleanupJob({ jobId: "job-1", action: "delete-document", targetKind: "configured-exclusion", source: "pi", nativeSessionId: "excluded", documentId: session.documentId, canonicalHash: "hash", phase: "planned", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  assert.equal(state.getGeneration("pi", "excluded", "hash")?.state, "cleanup_pending");
  assert.equal(state.claimGeneration(generation), false);
  state.updateCleanupJob("job-1", "remote_deleted");
  state.finalizeExcluded("pi", "excluded", "hash", "configured exclusion", "configured-exclusion");
  assert.equal(state.getGeneration("pi", "excluded", "hash")?.state, "excluded");
  assert.equal(state.getSession("pi", "excluded")?.status, "excluded_configured");
  state.close();
});

test("state requeues a cleaned primary generation with a fresh operation ID", () => {
  const state = new StateDatabase(":memory:");
  state.upsertSession(sessionRow("replay"));
  const oldId = operationIdFor("b", "agent-session:pi:replay", "hash");
  const newId = replayOperationIdFor("b", "agent-session:pi:replay", "hash", 1);
  state.upsertGeneration({ source: "pi", nativeSessionId: "replay", canonicalHash: "hash", operationId: oldId, state: "queued", queuedAt: new Date().toISOString(), attemptCount: 0 });
  state.planCleanupJob({ jobId: "job-replay", action: "delete-document", targetKind: "primary_replay", source: "pi", nativeSessionId: "replay", documentId: "agent-session:pi:replay", canonicalHash: "hash", oldOperationId: oldId, newOperationId: newId, phase: "planned", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  state.requeueAfterCleanup("pi", "replay", "hash", newId, "replay");
  assert.equal(state.getGeneration("pi", "replay", "hash")?.state, "queued");
  assert.equal(state.getGeneration("pi", "replay", "hash")?.operationId, newId);
  assert.notEqual(oldId, newId);
  state.close();
});

test("state can reset failed generations without touching completed ones", () => {
  const state = new StateDatabase(":memory:");
  state.upsertSession(sessionRow("s1"));
  const failed = { source: "pi" as const, nativeSessionId: "s1", canonicalHash: "h", operationId: operationIdFor("b", "d", "h"), state: "failed" as const, queuedAt: new Date().toISOString(), attemptCount: 3, error: "bad" };
  state.upsertGeneration(failed);
  assert.equal(state.resetFailed(), 1);
  assert.equal(state.getGeneration("pi", "s1", "h")?.state, "queued");
  state.close();
});
