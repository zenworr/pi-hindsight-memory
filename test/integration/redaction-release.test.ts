import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { operationIdFor, sha256 } from "../../src/common/hashing.js";
import { expectedRetainMission } from "../../src/common/retention-policy.js";
import { CLASSIFICATION_POLICY_VERSION, REDACTION_POLICY_VERSION } from "../../src/common/types.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { ImportWorker } from "../../src/importer/worker.js";
import { savePendingPayload, STALE_REDACTION_PAYLOAD } from "../../src/importer/pending-payload.js";
import { scan } from "../../src/importer/scanner.js";
import { importerHealth } from "../../src/importer/health.js";

const exec = promisify(execFile);
const timestamp = "2026-01-01T00:00:00.000Z";
const legacyCredential = 'TOKEN="[REDACTED:SECRET]CANARY"';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-redaction-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = defaultConfig(root);
  config.sourceRoots.pi = path.join(root, "work", "pi");
  config.sessionSettleSeconds = 0;
  config.requireImportApproval = false;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const sessionFile = (id: string) => path.join(config.sourceRoots.pi, `${id}.jsonl`);
  const session = (id: string, content: string) => fs.writeFile(sessionFile(id), [
    { type: "session", version: 3, id, timestamp },
    { type: "message", id: "msg-1", timestamp, message: { role: "user", content } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  return { config, root, session, sessionFile };
}

test("redaction rollout preserves acknowledged snapshots and the frozen set; the copied impact report emits counts only", async (t) => {
  const { config, root, session, sessionFile } = await fixture(t);
  await session("needs-redaction", legacyCredential);
  await session("stable", "ordinary text");
  await session("protected", legacyCredential);
  const legacyHashes = new Map<string, string>();
  const adapter = new PiAdapter(config.sourceRoots.pi);
  for await (const reference of adapter.discover()) {
    if (reference.nativeSessionId === "stable") continue;
    const payload = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
    try {
      const old = (await payload.readContent()).replace(JSON.stringify('TOKEN="[REDACTED:SECRET]"'), JSON.stringify(legacyCredential));
      assert.match(old, /CANARY/);
      legacyHashes.set(reference.nativeSessionId, sha256(old));
    } finally { await payload.cleanup(); }
  }
  const state = new StateDatabase(config.stateDatabase);
  try {
    assert.equal((await scan(config, state, { source: "pi" })).queued, 3);
    for (const generation of state.listGenerations()) {
      const id = generation.nativeSessionId;
      const hash = legacyHashes.get(id) ?? generation.canonicalHash;
      const record = state.getSession("pi", id)!;
      assert.match(record.sourceFingerprint.processing_signature ?? "", /\|3\|classification:/);
      state.upsertSession({ ...record, canonicalHash: hash });
      state.upsertGeneration({ ...generation, canonicalHash: hash, operationId: operationIdFor(config.hindsight.bankId, record.documentId, hash), state: "completed" });
      if (hash !== generation.canonicalHash) state.setGenerationState("pi", id, generation.canonicalHash, "superseded");
      if (id === "protected") state.setSessionClassification("pi", id, { kind: "ambiguous", reason: "fixture", policyVersion: CLASSIFICATION_POLICY_VERSION }, "ambiguous_preserved");
    }
  } finally { state.close(); }

  const stateCopy = path.join(root, "state-copy.sqlite3");
  const sourcesCopy = path.join(root, "sources-copy");
  await fs.copyFile(config.stateDatabase, stateCopy);
  await fs.mkdir(sourcesCopy, { mode: 0o700 });
  await fs.cp(config.sourceRoots.pi, path.join(sourcesCopy, config.localOrigin, "pi"), { recursive: true });
  const before = await fs.readFile(stateCopy);
  const args = ["scripts/checks/redaction-impact.mjs", "--state-copy", stateCopy, "--sources-copy", sourcesCopy];
  const { stdout } = await exec(process.execPath, args, { env: { ...process.env, PI_HINDSIGHT_CONFIG: path.join(root, "not-a-config.json") } });
  const counts = { acknowledged: 3, unchanged: 1, changed: 1, preservedAmbiguous: 1, unavailable: 0, errors: 0 };
  assert.deepEqual(JSON.parse(stdout), counts);
  assert.deepEqual(await fs.readFile(stateCopy), before);
  await fs.rm(path.join(sourcesCopy, config.localOrigin, "pi", "stable.jsonl"));
  await assert.rejects(exec(process.execPath, args), (error: { stdout: string; code: number }) => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), { ...counts, unchanged: 0, unavailable: 1 });
    return true;
  });

  const restarted = new StateDatabase(config.stateDatabase);
  try {
    await fs.rm(config.evidenceDatabase);
    assert.equal((await scan(config, restarted, { source: "pi" })).queued, 0);
    assert.equal((await scan(config, restarted, { source: "pi", indexOnly: true, force: true })).queued, 0);
    assert.equal((await scan(config, restarted, { source: "pi" })).queued, 0);
    assert.equal(restarted.getSession("pi", "needs-redaction")?.canonicalHash, legacyHashes.get("needs-redaction"));
    assert.equal(restarted.getSession("pi", "needs-redaction")?.acknowledgedHash, legacyHashes.get("needs-redaction"));
    assert.equal(restarted.getSession("pi", "protected")?.status, "ambiguous_preserved");
    await fs.appendFile(sessionFile("needs-redaction"), JSON.stringify({ type: "message", id: "msg-2", parentId: "msg-1", timestamp, message: { role: "user", content: "New source text" } }) + "\n");
    assert.equal((await scan(config, restarted, { source: "pi" })).queued, 1);
    assert.equal(restarted.getSession("pi", "protected")?.canonicalHash, legacyHashes.get("protected"));
  } finally { restarted.close(); }
});

test("stale pending payloads stay unresolved without submission, while already completed remote work reconciles", async (t) => {
  const { config, session } = await fixture(t);
  const operations = new Map([["prepared", "prepared"], ["lost", "pending"], ["done", "pending"], ["failed", "failed"]]);
  for (const id of operations.keys()) await session(id, `ordinary text: ${id}`);
  const state = new StateDatabase(config.stateDatabase);
  t.after(() => { state.close(); });
  assert.equal((await scan(config, state, { source: "pi" })).queued, operations.size);
  let completedId: string | undefined;
  let missingId: string | undefined;
  const adapter = new PiAdapter(config.sourceRoots.pi);
  for await (const ref of adapter.discover()) {
    assert.equal(ref.metadata.redaction_policy_version, REDACTION_POLICY_VERSION);
    const payload = await adapter.load(ref, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
    const id = ref.nativeSessionId;
    const generation = state.getGeneration("pi", id, payload.canonicalHash)!;
    try {
      payload.metadata.redaction_policy_version = "3";
      await savePendingPayload(config.spoolDirectory, generation.operationId, payload);
      state.upsertOperation({ operationId: generation.operationId, documentId: payload.documentId, canonicalHash: payload.canonicalHash, hindsightStatus: operations.get(id), retryCount: 0 });
      if (id === "done") completedId = generation.operationId;
      if (id === "lost") missingId = generation.operationId;
      state.setGenerationState("pi", id, generation.canonicalHash, id === "failed" ? "failed" : "submitted");
    } finally { await payload.cleanup(); }
  }

  const requests: string[] = [];
  const mission = await expectedRetainMission();
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && url.endsWith("/config")) {
      response.end(JSON.stringify({ config: { store_document_text: true, retain_strategies: { conversation: { retain_mission: mission, retain_extraction_mode: "concise" } }, enable_observations: true, observations_mission: "test", retain_default_strategy: "conversation" } }));
    } else if (request.method === "GET" && url === "/version") response.end("{}");
    else {
      requests.push(`${request.method} ${url.split("/").at(-1)}`);
      if (url.endsWith(`/operations/${completedId}`)) response.end(JSON.stringify({ status: "completed" }));
      else { response.statusCode = 404; response.end("{}"); }
    }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  const worker = new ImportWorker(config, state, new HindsightClient(config.hindsight, undefined, "test-token"));
  assert.deepEqual(await worker.runOnce(), { selected: 4, completed: 1, failed: 0, deferred: 3 });
  for (const id of ["prepared", "lost", "failed"]) {
    const generation = state.getLatestGeneration("pi", id)!;
    assert.equal(generation.state, "submitted");
    if (id === "lost") assert.match(generation.error!, /^unresolved-submission:/);
    else assert.equal(generation.error, STALE_REDACTION_PAYLOAD);
    await fs.access(path.join(config.spoolDirectory, "pending", `${generation.operationId}.jsonl`));
  }
  assert.equal(importerHealth(config, state.db).uncertain, 3);
  assert.equal(state.pendingWorkCount(config.importer.maxAttempts), 3);
  const held = state.getLatestGeneration("pi", "lost")!;
  state.upsertGeneration({ ...held, canonicalHash: "newer-hash", operationId: "newer-operation", state: "queued", error: undefined });
  assert.equal(state.hasRunnableWork(config.importer.maxAttempts), false);
  assert.equal((await worker.runOnce()).selected, 0);
  await assert.rejects(() => worker.drain(), /unresolved generations/);
  assert.deepEqual(requests.sort(), [`GET ${completedId}`, `GET ${missingId}`, "GET agent-session%3Api%3Alost"].sort());
});
