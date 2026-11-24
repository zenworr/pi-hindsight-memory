import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "../../src/common/config.js";
import { documentIdFor, operationIdFor } from "../../src/common/hashing.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { buildCleanupPlan } from "../../src/importer/cleanup-plan.js";
import { withWriterLock } from "../../src/importer/lock.js";
import { cleanupSubagents } from "../../src/importer/subagent-cleanup.js";

const date = "2026-01-01T00:00:00.000Z";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phm-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = defaultConfig(path.join(root, "dev"));
  config.localOrigin = "dev";
  config.sessionExclusions.exactLabels = ["exclude-this"];
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const documents = new Map<string, string>();
  const operations = new Map<string, string>();
  const deletes: string[] = [];
  let replaceOnGet: { id: string; hash: string; remaining: number } | undefined;
  let deleteStatus = 204;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const tail = url.pathname.split("/").slice(5);
    const id = decodeURIComponent(tail[1] ?? "");
    response.setHeader("Content-Type", "application/json");
    if (tail[0] === "documents") {
      if (!id && request.method === "GET") {
        response.end(JSON.stringify({ items: [...documents].map(([id, content_hash]) => ({ id, content_hash })) }));
        return;
      }
      if (request.method === "GET" && documents.has(id)) {
        if (replaceOnGet && replaceOnGet.id === id && --replaceOnGet.remaining === 0) documents.set(id, replaceOnGet.hash);
        response.end(JSON.stringify({ id, content_hash: documents.get(id) }));
        return;
      }
      if (request.method === "DELETE") {
        deletes.push(id);
        if (deleteStatus === 204) documents.delete(id);
        response.writeHead(deleteStatus).end();
        return;
      }
    }
    if (tail[0] === "operations" && operations.has(id)) {
      response.end(JSON.stringify({ operation_id: id, status: operations.get(id) }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }));
  const address = server.address();
  assert(address && typeof address === "object");
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  const client = new HindsightClient(config.hindsight, undefined, "test-token");
  const state = new StateDatabase(config.stateDatabase);
  t.after(() => { state.close(); });
  return {
    root, config, client, state, documents, operations, deletes,
    replaceOnGet(id: string, hash: string, remaining: number) { replaceOnGet = { id, hash, remaining }; },
    setDeleteStatus(status: number) { deleteStatus = status; },
    async write(id: string, kind: "subagent" | "ambiguous" | "configured" | "primary", directory = config.sourceRoots.pi) {
      const file = path.join(directory, `${id}.jsonl`);
      const lines = [{ type: "session", version: 3, id, timestamp: date, cwd: root, ...(kind === "ambiguous" || kind === "subagent" ? { parentSession: "/history/parent.jsonl" } : {}) }];
      const label = kind === "subagent" ? "advisor#deadbeef" : kind === "configured" ? "exclude-this" : undefined;
      await fs.writeFile(file, [...lines, ...(label ? [{ type: "session_info", name: label, id: "info-1", parentId: null, timestamp: date }] : [])].map((line) => JSON.stringify(line)).join("\n") + "\n");
      return file;
    },
    seed(id: string, locator: string, origin = config.localOrigin, status = "imported", source: "pi" | "claude" | "opencode" = "pi") {
      const documentId = documentIdFor(source, id);
      const canonicalHash = `${id}-hash`;
      const operationId = operationIdFor(config.hindsight.bankId, documentId, canonicalHash);
      state.upsertSession({ source, sourceOrigin: origin, nativeSessionId: id, documentId, sourceLocator: locator, sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "x", stableLocator: locator }, canonicalHash, canonicalBytes: 100, canonicalTurns: 2, status, lastSeenAt: date });
      state.upsertGeneration({ source, nativeSessionId: id, canonicalHash, operationId, state: "completed", queuedAt: date, attemptCount: 1 });
      documents.set(documentId, canonicalHash);
      return { documentId, canonicalHash, operationId };
    },
    async desktopGeneration(name: string) {
      const feed = path.join(root, "feed");
      const generation = path.join(feed, name);
      const directory = path.join(generation, "pi");
      await fs.mkdir(directory, { recursive: true });
      config.desktopFeed = { enabled: true, directory: path.join(feed, "current"), sourceHome: path.join(root, "desktop") };
      await fs.writeFile(path.join(generation, "manifest.json"), JSON.stringify({ version: 1, origin: "desktop", sourceHome: config.desktopFeed.sourceHome, generation: name }));
      return { directory, current: path.join(config.desktopFeed.directory, "pi"), async publish() {
        await fs.symlink(name, path.join(feed, "next"));
        await fs.rename(path.join(feed, "next"), config.desktopFeed.directory);
      } };
    },
  };
}

test("cleanup approves an explicit promotion only when the local owner exists", async (t) => {
  const f = await fixture(t);
  const feed = await f.desktopGeneration("gen-1");
  await f.write("handoff", "primary", feed.directory);
  await feed.publish();
  const { documentId } = f.seed("handoff", path.join(feed.current, "handoff.jsonl"), "desktop");
  f.config.promotedSessions.pi = ["handoff"];
  await assert.rejects(buildCleanupPlan(f.config, f.client), /is absent from dev/);
  const local = await f.write("handoff", "configured");
  const plan = await buildCleanupPlan(f.config, f.client);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0]?.origin, "dev");
  assert.equal(plan.jobs[0]?.locator, local);
  assert.equal(plan.jobs[0]?.storedOrigin, "desktop");
  assert.equal(plan.artifacts.configured, 1);
  assert.equal(f.state.listCleanupJobs().length, 0);
  await cleanupSubagents(f.config, f.client, plan);
  assert.deepEqual(f.deletes, [documentId]);
  assert.equal(f.state.getExclusionTombstone("pi", "handoff", documentId)?.locator, local);
});

test("cleanup rejects same-ID collisions between origins", async (t) => {
  const f = await fixture(t);
  const feed = await f.desktopGeneration("gen-1");
  await f.write("collision", "primary", feed.directory);
  await feed.publish();
  f.seed("collision", await f.write("collision", "configured"));
  await assert.rejects(buildCleanupPlan(f.config, f.client), /Duplicate pi session collision/);
  assert.equal(f.state.listCleanupJobs().length, 0);
  assert.deepEqual(f.deletes, []);
});

test("cleanup plan is stable across reordered desktop feed generations", async (t) => {
  const f = await fixture(t);
  const first = await f.desktopGeneration("gen-1");
  for (const id of ["one", "two"]) {
    await f.write(id, "subagent", first.directory);
    f.seed(id, path.join(first.current, `${id}.jsonl`), "desktop");
  }
  await first.publish();
  const plan = await buildCleanupPlan(f.config, f.client);
  const second = await f.desktopGeneration("gen-2");
  for (const id of ["two", "one"]) await fs.copyFile(path.join(first.directory, `${id}.jsonl`), path.join(second.directory, `${id}.jsonl`));
  await second.publish();
  assert.equal((await buildCleanupPlan(f.config, f.client)).planHash, plan.planHash);
  const result = await cleanupSubagents(f.config, f.client, plan);
  assert.equal(result.remoteDeleted, 2);
  assert.deepEqual(new Set(f.deletes), new Set([documentIdFor("pi", "one"), documentIdFor("pi", "two")]));
});

test("cleanup rejects stale presence, content, and bank bindings before changing state", async (t) => {
  const f = await fixture(t);
  const { documentId, canonicalHash } = f.seed("child", await f.write("child", "subagent"));
  const plan = await buildCleanupPlan(f.config, f.client);
  assert.equal(plan.jobs[0]?.remoteContentHash, canonicalHash);
  f.documents.set(documentId, "changed-outside-importer");
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /plan changed after review/);
  assert.equal((await buildCleanupPlan(f.config, f.client)).blocked[0]?.reason, "unexpected-remote-generation");
  f.documents.delete(documentId);
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /plan changed after review/);
  f.documents.set(documentId, canonicalHash);
  const otherBank = new HindsightClient({ ...f.config.hindsight, bankId: "another" }, undefined, "test-token");
  await assert.rejects(cleanupSubagents(f.config, otherBank, plan), /plan changed after review/);
  const otherEndpointConfig = { ...f.config, hindsight: { ...f.config.hindsight, apiUrl: `${f.config.hindsight.apiUrl}/` } };
  await assert.rejects(cleanupSubagents(otherEndpointConfig, f.client, plan), /plan changed after review/);
  await assert.rejects(withWriterLock(f.config.stateDatabase, () => cleanupSubagents(f.config, f.client, plan)), /writer lock is busy/);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.state.listCleanupJobs().length, 0);
});

test("cleanup rechecks the remote generation before journaling and does not retry a destructive request", async (t) => {
  const f = await fixture(t);
  const { documentId, canonicalHash } = f.seed("child", await f.write("child", "subagent"));
  const plan = await buildCleanupPlan(f.config, f.client);
  f.replaceOnGet(documentId, "changed-during-apply", 1);
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /target changed after review/);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.state.listCleanupJobs().length, 0);
  f.documents.set(documentId, canonicalHash);
  f.setDeleteStatus(503);
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /failed with HTTP 503/);
  assert.deepEqual(f.deletes, [documentId]);
  assert.equal(f.state.listCleanupJobs()[0]?.phase, "planned");
  f.documents.delete(documentId);
  const recovery = await buildCleanupPlan(f.config, f.client);
  const result = await cleanupSubagents(f.config, f.client, recovery);
  assert.equal(result.remoteDeleted, 0);
  assert.equal(f.state.listCleanupJobs()[0]?.phase, "state_finalized");
  assert.equal(f.state.getSession("pi", "child")?.acknowledgedHash, undefined);
});

test("cleanup plans only settled operations and binds the observed result", async (t) => {
  const f = await fixture(t);
  const { documentId, canonicalHash, operationId } = f.seed("child", await f.write("child", "subagent"));
  f.state.upsertOperation({ documentId, canonicalHash, operationId, hindsightStatus: "pending", retryCount: 0 });
  f.operations.set(operationId, "pending");
  const waiting = await buildCleanupPlan(f.config, f.client);
  assert.equal(waiting.jobs.length, 0);
  assert.equal(waiting.blocked[0]?.reason, "unresolved-operation");
  f.operations.set(operationId, "completed");
  const ready = await buildCleanupPlan(f.config, f.client);
  assert.equal(ready.jobs[0]?.operations[0]?.status, "completed");
  f.operations.set(operationId, "failed");
  await assert.rejects(cleanupSubagents(f.config, f.client, ready), /plan changed after review/);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.state.listCleanupJobs().length, 0);
});

test("cleanup rejects a conflicting persisted job", async (t) => {
  const f = await fixture(t);
  const { documentId, canonicalHash, operationId } = f.seed("child", await f.write("child", "subagent"));
  const plan = await buildCleanupPlan(f.config, f.client);
  const { jobId } = plan.jobs[0]!.generations[0]!;
  f.state.planCleanupJob({ jobId, action: "delete-document", targetKind: "primary_replay", source: "pi", nativeSessionId: "child", documentId, canonicalHash, oldOperationId: operationId, newOperationId: "unexpected", phase: "planned", createdAt: date, updatedAt: date });
  assert.equal((await buildCleanupPlan(f.config, f.client)).blocked[0]?.reason, "conflicting-cleanup-job");
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /plan changed after review/);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.state.getCleanupJob(jobId)?.targetKind, "primary_replay");
});

test("cleanup preserves a missing source even when a configured exclusion tombstone exists", async (t) => {
  const f = await fixture(t);
  const source = await f.write("missing", "configured");
  const { documentId } = f.seed("missing", source);
  f.state.recordExclusionTombstone({ source: "pi", nativeSessionId: "missing", documentId, locator: source, label: "exclude-this", normalizedLabel: "exclude-this", createdAt: date, updatedAt: date });
  const plan = await buildCleanupPlan(f.config, f.client);
  await fs.rm(source);
  await assert.rejects(cleanupSubagents(f.config, f.client, plan), /plan changed after review/);
  const missing = await buildCleanupPlan(f.config, f.client);
  assert.equal(missing.jobs.length, 0);
  assert.equal(missing.blocked[0]?.reason, "source-missing");
  assert.equal(f.documents.has(documentId), true);
  assert.equal(f.state.listCleanupJobs().length, 0);
});

test("cleanup preserves a missing Claude primary when a sidechain shares its ID", async (t) => {
  const f = await fixture(t);
  const root = f.config.sourceRoots.claude;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "agent-child.jsonl"), `${JSON.stringify({ sessionId: "shared", uuid: "child", parentUuid: null, timestamp: date, isSidechain: true, type: "assistant", message: { role: "assistant", content: "child" } })}\n`);
  f.seed("shared", path.join(root, "primary.jsonl"), f.config.localOrigin, "imported", "claude");
  const plan = await buildCleanupPlan(f.config, f.client);
  assert.equal(plan.artifacts.subagents, 1);
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.blocked[0]?.reason, "source-owner-changed");
});

test("cleanup can review a legacy OpenCode database locator without changing the source", async (t) => {
  const f = await fixture(t);
  const file = f.config.opencodeDatabase;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const source = new DatabaseSync(file);
  source.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO session (id, title, time_created, time_updated) VALUES ('ses-excluded', 'exclude-this', 1760000000000, 1760000000000);`);
  source.close();
  const { documentId } = f.seed("ses-excluded", file, f.config.localOrigin, "imported", "opencode");
  const before = await fs.readFile(file);
  const plan = await buildCleanupPlan(f.config, f.client);
  assert.equal(plan.jobs[0]?.locator, `${file}#ses-excluded`);
  await cleanupSubagents(f.config, f.client, plan);
  assert.deepEqual(f.deletes, [documentId]);
  assert.deepEqual(await fs.readFile(file), before);
});

test("cleanup journals only reviewed jobs, deletes each document once, and preserves frozen ambiguity", async (t) => {
  const f = await fixture(t);
  const reviewed = f.seed("reviewed", await f.write("reviewed", "subagent"));
  f.state.upsertGeneration({ source: "pi", nativeSessionId: "reviewed", canonicalHash: "another-hash", operationId: "another-operation", state: "queued", queuedAt: date, attemptCount: 0 });
  f.state.upsertOperation({ documentId: reviewed.documentId, canonicalHash: "another-hash", operationId: "another-operation", hindsightStatus: "prepared", retryCount: 0 });
  f.state.upsertOperation({ ...reviewed, hindsightStatus: "completed", retryCount: 0 });
  assert.equal(f.state.reserveBudget(reviewed.operationId, 10, 0, null, 0), true);
  assert.equal(f.state.reserveBudget("another-operation", 20, 0, null, 0), true);
  const unreviewed = f.seed("unreviewed", await f.write("unreviewed", "configured"));
  const frozen = f.seed("frozen", await f.write("frozen", "configured"), f.config.localOrigin, "ambiguous_preserved");
  const ambiguous = f.seed("ambiguous", await f.write("ambiguous", "ambiguous"));
  const definite = await buildCleanupPlan(f.config, f.client);
  assert.equal(definite.jobs.length, 2);
  const plan = await buildCleanupPlan(f.config, f.client, { includeAmbiguous: true });
  assert.equal(plan.jobs.length, 3);
  const job = plan.jobs.find((job) => job.documentId === reviewed.documentId)!;
  await assert.rejects(cleanupSubagents(f.config, f.client, { ...plan, jobs: [job] }), /plan changed after review/);
  await assert.rejects(cleanupSubagents(f.config, f.client, { ...plan, jobIds: new Set([job.jobId, "unreviewed-id"]) }), /not in the reviewed plan/);
  assert.equal(f.state.listCleanupJobs().length, 0);
  const result = await cleanupSubagents(f.config, f.client, { ...plan, jobIds: new Set([job.jobId]) });
  assert.equal(result.excluded, 2);
  assert.equal(f.state.budget().reservedInputTokens, 10);
  assert.deepEqual(f.deletes, [reviewed.documentId]);
  assert.deepEqual(f.state.listCleanupJobs().map((job) => job.nativeSessionId), ["reviewed", "reviewed"]);
  assert.equal(f.documents.has(unreviewed.documentId), true);
  assert.equal(f.state.getExclusionTombstone("pi", "unreviewed", unreviewed.documentId), undefined);
  assert.equal(f.documents.has(ambiguous.documentId), true);
  assert.equal(f.documents.has(frozen.documentId), true);
  assert.equal(f.state.getSession("pi", "frozen")?.status, "ambiguous_preserved");
});
