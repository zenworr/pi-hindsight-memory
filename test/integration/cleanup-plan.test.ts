import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "../../src/common/config.js";
import { documentIdFor, operationIdFor } from "../../src/common/hashing.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { buildCleanupPlan } from "../../src/importer/cleanup-plan.js";
import { cleanupSubagents } from "../../src/importer/subagent-cleanup.js";

async function createEmptyOpenCodeDatabase(databasePath: string): Promise<void> {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  database.close();
}

async function cleanupConfig(root: string) {
  const config = defaultConfig(root);
  config.stateDirectory = path.join(root, "state");
  config.stateDatabase = path.join(root, "state", "state.sqlite3");
  config.reportDirectory = path.join(root, "state", "reports");
  config.spoolDirectory = path.join(root, "state", "canonical");
  config.sourceRoots.pi = path.join(root, "pi");
  config.sourceRoots.codex = path.join(root, "codex");
  config.sourceRoots.claude = path.join(root, "claude");
  config.sourceRoots.opencode = path.join(root, "opencode.db");
  config.codexStateDatabase = path.join(root, "state-5.sqlite");
  return config;
}

test("cleanup plan excludes ambiguous sessions unless explicitly requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cleanup-ambiguous-"));
  const config = await cleanupConfig(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await createEmptyOpenCodeDatabase(config.opencodeDatabase);
  const sourcePath = path.join(config.sourceRoots.pi, "fork.jsonl");
  await fs.writeFile(sourcePath, '{"type":"session","version":3,"id":"fork-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n', "utf8");
  const documentId = documentIdFor("pi", "fork-session");
  const state = new StateDatabase(config.stateDatabase);
  state.upsertSession({ source: "pi", nativeSessionId: "fork-session", documentId, sourceLocator: sourcePath, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: sourcePath }, canonicalHash: "fork-hash", canonicalBytes: 100, canonicalTurns: 2, canonicalSchema: "agent-session-v1", sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.000Z", status: "imported", lastSeenAt: new Date().toISOString() });
  state.upsertGeneration({ source: "pi", nativeSessionId: "fork-session", canonicalHash: "fork-hash", operationId: operationIdFor(config.hindsight.bankId, documentId, "fork-hash"), state: "completed", queuedAt: "2026-01-01T00:00:00.000Z", attemptCount: 1 });
  state.close();
  const fakeClient = { listDocumentIds: async () => new Set([documentId]) } as unknown as HindsightClient;
  const definiteOnly = await buildCleanupPlan(config, fakeClient);
  const withAmbiguous = await buildCleanupPlan(config, fakeClient, { includeAmbiguous: true });
  assert.equal(definiteOnly.config.includeAmbiguous, false);
  assert.equal(definiteOnly.jobs.length, 0);
  assert.equal(withAmbiguous.config.includeAmbiguous, true);
  assert.equal(withAmbiguous.jobs.length, 1);
  assert.equal(withAmbiguous.jobs[0]?.targetKind, "ambiguous");
  assert.notEqual(definiteOnly.planHash, withAmbiguous.planHash);
  await fs.rm(root, { recursive: true, force: true });
});

test("definite cleanup deletes only reviewed job IDs and leaves ambiguous documents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cleanup-definite-"));
  const config = await cleanupConfig(root);
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await createEmptyOpenCodeDatabase(config.opencodeDatabase);
  const subagentPath = path.join(config.sourceRoots.pi, "subagent.jsonl");
  const ambiguousPath = path.join(config.sourceRoots.pi, "fork.jsonl");
  await fs.writeFile(subagentPath, '{"type":"session","version":3,"id":"definite-child","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n{"type":"session_info","name":"advisor#deadbeef","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  await fs.writeFile(ambiguousPath, '{"type":"session","version":3,"id":"ambiguous-child","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n', "utf8");
  const state = new StateDatabase(config.stateDatabase);
  for (const [nativeSessionId, sourceLocator] of [["definite-child", subagentPath], ["ambiguous-child", ambiguousPath]] as const) {
    const documentId = documentIdFor("pi", nativeSessionId);
    const canonicalHash = `${nativeSessionId}-hash`;
    state.upsertSession({ source: "pi", nativeSessionId, documentId, sourceLocator, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: sourceLocator }, canonicalHash, canonicalBytes: 100, canonicalTurns: 2, canonicalSchema: "agent-session-v1", sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.000Z", status: "imported", lastSeenAt: new Date().toISOString() });
    state.upsertGeneration({ source: "pi", nativeSessionId, canonicalHash, operationId: operationIdFor(config.hindsight.bankId, documentId, canonicalHash), state: "completed", queuedAt: "2026-01-01T00:00:00.000Z", attemptCount: 1 });
  }
  const prepared = state.getLatestGeneration("pi", "definite-child")!;
  state.setGenerationState("pi", "definite-child", prepared.canonicalHash, "submitted");
  state.upsertOperation({ operationId: prepared.operationId, documentId: documentIdFor("pi", "definite-child"), canonicalHash: prepared.canonicalHash, hindsightStatus: "prepared", retryCount: 0 });
  const documents = new Set([documentIdFor("pi", "definite-child"), documentIdFor("pi", "ambiguous-child")]);
  const deleted: string[] = [];
  const fakeClient = {
    listDocumentIds: async () => new Set(documents),
    deleteDocument: async (documentId: string) => { deleted.push(documentId); documents.delete(documentId); },
    getOperation: async () => assert.fail("a prepared local payload was not submitted remotely"),
  } as unknown as HindsightClient;
  try {
    const plan = await buildCleanupPlan(config, fakeClient);
    assert.deepEqual(plan.jobs.map((job) => job.nativeSessionId), ["definite-child"]);
    await cleanupSubagents(config, state, fakeClient, { jobIds: new Set(plan.jobs.map((job) => job.jobId)) });
    assert.deepEqual(deleted, [documentIdFor("pi", "definite-child")]);
    assert.equal(state.getGeneration("pi", "definite-child", "definite-child-hash")?.state, "excluded");
    assert.equal(state.getGeneration("pi", "ambiguous-child", "ambiguous-child-hash")?.state, "completed");
  } finally { state.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("cleanup preserves a persisted Claude primary artifact when only its sidechain remains", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cleanup-claude-primary-"));
  const config = await cleanupConfig(root);
  await fs.mkdir(config.sourceRoots.claude, { recursive: true });
  await createEmptyOpenCodeDatabase(config.opencodeDatabase);
  const missingPrimary = path.join(config.sourceRoots.claude, "primary.jsonl");
  const sidechain = path.join(config.sourceRoots.claude, "agent-child.jsonl");
  await fs.writeFile(sidechain, '{"sessionId":"shared","uuid":"child","parentUuid":null,"timestamp":"2026-01-01T00:00:01.000Z","isSidechain":true,"type":"assistant","message":{"role":"assistant","content":"child"}}\n', "utf8");
  const documentId = documentIdFor("claude", "shared");
  const state = new StateDatabase(config.stateDatabase);
  state.upsertSession({ source: "claude", nativeSessionId: "shared", documentId, sourceLocator: missingPrimary, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: missingPrimary }, canonicalHash: "primary-hash", canonicalBytes: 100, canonicalTurns: 2, canonicalSchema: "agent-session-v1", sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.000Z", status: "imported", lastSeenAt: new Date().toISOString(), classification: { kind: "primary", reason: "claude-primary-session", policyVersion: "2" } });
  state.recordArtifact({ source: "claude", locator: missingPrimary, nativeSessionId: "shared", documentId, classification: { kind: "primary", reason: "claude-primary-session", policyVersion: "2" }, observedAt: "2026-01-01T00:00:00.000Z" });
  state.upsertGeneration({ source: "claude", nativeSessionId: "shared", canonicalHash: "primary-hash", operationId: operationIdFor(config.hindsight.bankId, documentId, "primary-hash"), state: "completed", queuedAt: "2026-01-01T00:00:00.000Z", attemptCount: 1 });
  state.close();
  const plan = await buildCleanupPlan(config, { listDocumentIds: async () => new Set([documentId]) } as unknown as HindsightClient);
  assert.equal(plan.artifacts.subagents, 1);
  assert.equal(plan.jobs.length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("cleanup plan finds configured labels without mutating source or replaying active primary work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cleanup-plan-"));
  const config = await cleanupConfig(root);
  config.sessionExclusions.exactLabels = ["excluded-session"];
  await fs.mkdir(path.dirname(config.opencodeDatabase), { recursive: true });
  const sourceDb = new DatabaseSync(config.opencodeDatabase);
  sourceDb.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  sourceDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-excluded", null, "p", "/tmp", "excluded-session", "1", "general", "model", 1760000000000, 1760000000000, null);
  sourceDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-primary", null, "p", "/tmp", "ordinary", "1", "general", "model", 1760000001000, 1760000001000, null);
  sourceDb.close();

  const state = new StateDatabase(config.stateDatabase);
  const excludedDocument = documentIdFor("opencode", "ses-excluded");
  const primaryDocument = documentIdFor("opencode", "ses-primary");
  state.upsertSession({ source: "opencode", nativeSessionId: "ses-excluded", documentId: excludedDocument, sourceLocator: config.opencodeDatabase, sourceSize: 0, sourceMtime: 0, sourceFingerprint: { size: 0, mtimeMs: 0, sampleHash: "", stableLocator: `${config.opencodeDatabase}#ses-excluded` }, canonicalHash: "excluded-hash", canonicalBytes: 100, canonicalTurns: 2, canonicalSchema: "agent-session-v1", sessionStartedAt: "2025-01-01T00:00:00.000Z", sessionUpdatedAt: "2025-01-01T00:00:00.000Z", status: "imported", lastSeenAt: new Date().toISOString() });
  state.upsertSession({ source: "opencode", nativeSessionId: "ses-primary", documentId: primaryDocument, sourceLocator: config.opencodeDatabase, sourceSize: 0, sourceMtime: 0, sourceFingerprint: { size: 0, mtimeMs: 0, sampleHash: "", stableLocator: `${config.opencodeDatabase}#ses-primary` }, canonicalHash: "primary-hash", canonicalBytes: 100, canonicalTurns: 2, canonicalSchema: "agent-session-v1", sessionStartedAt: "2025-01-01T00:00:00.000Z", sessionUpdatedAt: "2025-01-01T00:00:00.000Z", status: "discovered", lastSeenAt: new Date().toISOString() });
  state.upsertGeneration({ source: "opencode", nativeSessionId: "ses-excluded", canonicalHash: "excluded-hash", operationId: operationIdFor(config.hindsight.bankId, excludedDocument, "excluded-hash"), state: "completed", queuedAt: "2025-01-01T00:00:00.000Z", attemptCount: 1 });
  state.upsertGeneration({ source: "opencode", nativeSessionId: "ses-primary", canonicalHash: "primary-hash", operationId: operationIdFor(config.hindsight.bankId, primaryDocument, "primary-hash"), state: "submitted", queuedAt: "2025-01-01T00:00:01.000Z", attemptCount: 1 });
  state.close();
  const before = await fs.readFile(config.opencodeDatabase);
  const fakeClient = { listDocumentIds: async () => new Set([excludedDocument, primaryDocument]) } as unknown as HindsightClient;
  const plan = await buildCleanupPlan(config, fakeClient);
  assert.equal(plan.artifacts.configured, 1);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0]?.targetKind, "configured-exclusion");
  assert.equal(plan.jobs[0]?.nativeSessionId, "ses-excluded");
  assert.equal(plan.jobs[0]?.remoteDocumentPresent, true);
  assert.deepEqual(await fs.readFile(config.opencodeDatabase), before);
  const readState = new DatabaseSync(config.stateDatabase, { readOnly: true });
  assert.equal(Number((readState.prepare("SELECT count(*) AS count FROM cleanup_jobs").get() as { count: number }).count), 0);
  readState.close();
  await fs.rm(root, { recursive: true, force: true });
});
