import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { documentIdFor, sha256 } from "../../src/common/hashing.js";
import { expectedRetainMission } from "../../src/common/retention-policy.js";
import type { ImportApproval } from "../../src/common/types.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { runInventory } from "../../src/importer/inventory.js";
import { selectPilot } from "../../src/importer/pilot.js";
import { queuePilot } from "../../src/importer/pilot-queue.js";
import { runPilot } from "../../src/importer/pilot-runner.js";
import { buildRepairPlan, repairHistory } from "../../src/importer/repair.js";
import { scan } from "../../src/importer/scanner.js";
import { StateDatabase } from "../../src/importer/state-db.js";

const previousHash = sha256("old canonical content");
const documentId = documentIdFor("pi", "one");
const approval: ImportApproval = { approvedAt: "2026-01-01", provider: "synthetic", model: "synthetic", privacy: "remote-redacted", maxEstimatedInputTokens: null, maxEstimatedCostUsd: 0 };
const timestamp = "2026-01-01T00:00:00Z";
const record = (value: unknown) => `${JSON.stringify(value)}\n`;

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-reviewed-"));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const config = defaultConfig(root);
  config.requireImportApproval = false;
  config.maxInflightDocuments = 1;
  config.hindsight.httpMaxAttempts = 1;
  await fs.mkdir(path.dirname(config.hindsight.apiTokenFile), { recursive: true });
  await fs.writeFile(config.hindsight.apiTokenFile, "synthetic-test");
  const state = new StateDatabase(config.stateDatabase);
  t.after(() => { state.close(); });
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  async function write(id: string, content: string, label?: string) {
    const file = path.join(config.sourceRoots.pi, `${id}.jsonl`);
    await fs.writeFile(file, record({ type: "session", version: 3, id, timestamp, cwd: "/synthetic" })
      + record({ type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content } })
      + (label ? record({ type: "session_info", name: label }) : ""));
    return file;
  }
  await write("one", "keep alpha");
  const remote = { hash: previousHash, pilotFailure: false, retainWrongHash: false };
  const requests: string[] = [];
  const mission = await expectedRetainMission();
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url!, "http://localhost");
    const route = `${req.method} ${pathname.split(`/banks/${config.hindsight.bankId}`).at(-1)}`;
    requests.push(route);
    const reply = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    switch (route) {
      case "GET /config": return reply({ config: { store_document_text: true, retain_default_strategy: "conversation", retain_strategies: { conversation: { retain_extraction_mode: "concise", retain_mission: mission } }, enable_observations: true, observations_mission: "Synthetic mission", enable_auto_consolidation: false } });
      case "GET /version": return reply({});
      case "GET /documents": return reply({ items: remote.hash ? [{ id: documentId, content_hash: remote.hash }] : [] });
      case `GET /documents/${encodeURIComponent(documentId)}`: return remote.hash ? reply({ id: documentId, content_hash: remote.hash }) : reply({}, 404);
      case `DELETE /documents/${encodeURIComponent(documentId)}`: remote.hash = ""; return reply({});
      case "GET /stats": return reply({ failed_operations: 42, failed_consolidation: 3, pending_consolidation: 0 });
      case "POST /memories/dry-run-extract": req.resume(); return reply({}, remote.pilotFailure ? 422 : 200);
      case "POST /memories": {
        let body = "";
        req.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
        return req.on("end", () => {
          const request = JSON.parse(body) as { items: { content: string }[]; operation_id: string };
          remote.hash = remote.retainWrongHash ? previousHash : sha256(request.items[0]!.content);
          reply({ operation_id: request.operation_id });
        });
      }
      default: return route.startsWith("GET /operations/") ? reply({ status: "completed" }) : reply({}, 404);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error); else resolve();
  })));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  const client = new HindsightClient(config.hindsight);
  const writes = () => requests.filter((request) => !request.startsWith("GET "));
  async function plan() {
    await scan(config, state, { source: "pi", force: true, indexOnly: true });
    state.db.prepare("UPDATE sessions SET acknowledged_hash=?, acknowledged_policy='1'").run(previousHash);
    await fs.writeFile(path.join(config.stateDirectory, "paused"), "maintenance");
    return buildRepairPlan(config, client);
  }
  const pilot = async () => selectPilot(await runInventory(config, { source: "pi" }));
  return { root, config, state, client, requests, remote, write, plan, pilot, writes };
}

test("repair rejects same-size source changes and changed classification before remote writes", async (t) => {
  const f = await fixture(t);
  f.config.sessionExclusions.exactLabels = ["excluded"];
  const plan = await f.plan();
  const apply = () => repairHistory(f.config, f.state, f.client, plan);
  await f.write("one", "keep bravo");
  assert.equal((await f.pilot())[0]?.canonicalBytes, plan.targets[0]?.canonicalBytes);
  await assert.rejects(apply, /build and review a new plan/);
  await f.write("one", "keep alpha", "excluded");
  await assert.rejects(apply, /build and review a new plan/);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.state.listGenerations().length, 0);
  assert.equal(f.state.getSession("pi", "one")?.classification?.kind, "primary");
});

test("repair rejects pending work outside the plan and wrong hashes on resume", async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const apply = () => repairHistory(f.config, f.state, f.client, plan);
  await f.write("two", "unreviewed content");
  await scan(f.config, f.state, { source: "pi", sessionIds: ["two"], force: true });
  await assert.rejects(apply, /outside the approved repair plan/);
  const g = f.state.getLatestGeneration("pi", "two")!;
  f.state.setGenerationState("pi", "two", g.canonicalHash, "superseded");
  await f.write("one", "keep bravo");
  await scan(f.config, f.state, { source: "pi", sessionIds: ["one"], force: true });
  await assert.rejects(apply, /build and review a new plan/);
  const wrong = f.state.getLatestGeneration("pi", "one")!;
  f.state.setGenerationState("pi", "one", wrong.canonicalHash, "superseded");
  await f.write("one", "keep alpha");
  await scan(f.config, f.state, { source: "pi", sessionIds: ["one"], force: true });
  const reviewed = f.state.getLatestGeneration("pi", "one")!;
  f.state.upsertOperation({ operationId: reviewed.operationId, documentId, canonicalHash: reviewed.canonicalHash, hindsightStatus: "ready", retryCount: 0 });
  f.remote.hash = wrong.canonicalHash;
  await assert.rejects(apply, /remote document changed/);
  assert.deepEqual(f.writes(), []);
});

test("repair ignores historical failures, verifies the reviewed replacement, and does not replay completed work", async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  const apply = () => repairHistory(f.config, f.state, f.client, plan, { maxMs: 10_000 });
  assert.equal((await apply()).repaired, 1);
  const writes = [`DELETE /documents/${encodeURIComponent(documentId)}`, "POST /memories"];
  assert.deepEqual(f.writes(), writes);
  assert.equal(f.remote.hash, plan.targets[0]?.canonicalHash);
  await apply();
  f.remote.hash = previousHash;
  f.state.db.prepare("UPDATE sessions SET acknowledged_hash=?").run(previousHash);
  await assert.rejects(apply, /Repaired document hash verification failed/);
  assert.deepEqual(f.writes(), writes);
});

test("repair checks the reviewed remote hash before consolidation", async (t) => {
  const f = await fixture(t);
  const plan = await f.plan();
  f.remote.retainWrongHash = true;
  await assert.rejects(() => repairHistory(f.config, f.state, f.client, plan), /Repaired document hash verification failed/);
  assert.ok(!f.requests.includes("GET /stats"));
});

test("pilot rejects stale bytes, classification, identity, locator, origin and size without provider calls", async (t) => {
  const f = await fixture(t);
  f.config.sessionExclusions.exactLabels = ["excluded"];
  await f.write("two", "second valid session");
  const entries = await f.pilot();
  assert.equal(entries.length, 2);
  const first = entries.find((entry) => entry.nativeSessionId === "one")!;
  const second = entries.find((entry) => entry.nativeSessionId === "two")!;
  const check = (input = entries) => assert.rejects(() => runPilot(f.config, input, approval), /regenerate the inventory and pilot/);
  for (const change of [{ origin: "wrong" }, { nativeSessionId: "wrong" }, { locator: second.locator }, { canonicalBytes: 1 }, { canonicalHash: "" }]) await check([second, { ...first, ...change }]);
  await f.write("one", "keep bravo");
  assert.equal((await f.pilot()).find((entry) => entry.nativeSessionId === "one")?.canonicalBytes, first.canonicalBytes);
  await check([second, first]);
  await assert.rejects(() => queuePilot(f.config, f.state, entries), /regenerate the inventory and pilot/);
  assert.deepEqual(f.state.listGenerations(), []);
  await f.write("one", "keep alpha", "excluded");
  await check();
  await f.write("one", "keep alpha");
  await assert.rejects(() => runPilot(f.config, entries, { ...approval, maxEstimatedInputTokens: 1 }), /exceeds approved input-token limit/);
  assert.deepEqual(f.requests, [], "not even bank initialization is permitted on rejection");
  assert.deepEqual(await fs.readdir(f.config.spoolDirectory), []);
});

test("pilot CLI exits non-zero and writes diagnostics without printing success counts when extraction fails", async (t) => {
  const f = await fixture(t);
  const { configPath, ...overrides } = f.config;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(overrides));
  await fs.writeFile(f.config.hindsight.environmentFile, "HINDSIGHT_API_LLM_PROVIDER=synthetic\nHINDSIGHT_API_LLM_MODEL=synthetic\n");
  await fs.writeFile(f.config.approvalFile, JSON.stringify(approval));
  const input = path.join(f.root, "pilot.json");
  const output = path.join(f.root, "results.json");
  await fs.writeFile(input, JSON.stringify(await f.pilot()));
  f.remote.pilotFailure = true;
  await assert.rejects(() => promisify(execFile)(process.execPath, [path.resolve("dist/src/importer/cli.js"), "run-pilot", "--config", configPath, input, output], { env: { HOME: f.root, PATH: process.env.PATH, PI_HINDSIGHT_TELEMETRY_FILE: "/dev/null" } }), (error: Error & { code: number; stdout: string; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /Pilot failed for 1 session/);
    return true;
  });
  assert.match(await fs.readFile(output, "utf8"), /HTTP 422/);
  assert.deepEqual(f.writes(), ["POST /memories/dry-run-extract"]);
});
