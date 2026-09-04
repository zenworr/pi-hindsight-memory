import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import piHindsightMemory, { createMemorySearchTool } from "../../src/extension/index.js";
import { collectHindsightStatus, HINDSIGHT_STATUS_REQUEST_EVENT, registerHindsightStatusProvider, type HindsightStatusSnapshotV1 } from "../../src/extension/status.js";

function client(response: unknown): HindsightClient {
  return new HindsightClient({ apiUrl: "http://example.test", environmentFile: "/unused", bankId: "coding-history", apiTokenFile: "/unused", requestTimeoutMs: 1000, retainWallTimeoutMs: 1000, recallMaxTokens: 2500, recallChunksMaxTokens: 2500, recallSourceFactsMaxTokens: 1500, operationPollMs: 1, operationPollTimeoutMs: 1000, operationRetentionDays: 14 }, async () => new Response(JSON.stringify(response), { status: 200 }), "token");
}

test("the extension exposes exactly one small memory search tool shape", async () => {
  const tool = createMemorySearchTool(client({ results: [{ id: "1", text: "The user prefers simple designs", type: "observation", metadata: { source: "pi", native_session_id: "s1" }, document_id: "agent-session:pi:s1" }] }));
  assert.equal(tool.name, "memory_search");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["query"]);
  const result = await tool.execute("call-1", { query: "simple designs" }, undefined, undefined, {} as any);
  assert.equal(result.content[0]?.type, "text");
  assert.match(String(result.content[0]?.text), /simple designs/);
  assert.equal(result.details?.resultCount, 1);
});

test("extension registers memory_search only after the Pi runtime starts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-runtime-"));
  await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const tools: any[] = [];
    const fakePi: any = {
      getAllTools: () => tools,
      registerTool: (tool: any) => { tools.push(tool); },
      on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
      events: { on: () => () => {}, emit: () => {} },
    };
    piHindsightMemory(fakePi);
    assert.equal(tools.length, 0);
    await handlers.get("session_start")?.({}, {});
    assert.deepEqual(tools.map((tool) => tool.name), ["memory_search"]);
    await handlers.get("session_start")?.({}, {});
    assert.equal(tools.length, 1);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runtime collision check refuses an existing memory_search tool", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-collision-"));
  await fs.writeFile(path.join(directory, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    let start: ((...args: any[]) => unknown) | undefined;
    const fakePi: any = {
      getAllTools: () => [{ name: "memory_search", sourceInfo: { path: "/other/extension.ts" } }],
      registerTool: () => assert.fail("must not replace an existing memory_search"),
      on: (event: string, handler: (...args: any[]) => unknown) => { if (event === "session_start") start = handler; },
      events: { on: () => () => {}, emit: () => {} },
    };
    piHindsightMemory(fakePi);
    assert.throws(() => start?.({}, {}), /already registered by \/other\/extension\.ts/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("status provider exposes queue and service health without secrets", async () => {
  const config = defaultConfig("/home/test");
  const executor = {
    async exec() { return { stdout: "2|1|3|4|5\n", stderr: "", code: 0 }; },
  };
  const statusClient = {
    async health() { return { status: "healthy", database: "connected" }; },
    async getBankStats() {
      return {
        total_documents: 42,
        pending_operations: 2,
        failed_operations: 6,
        pending_consolidation: 7,
        failed_consolidation: 8,
        operations_by_status: { processing: 1 },
      };
    },
    async listOperations() { return [{ id: "op-1", status: "processing", task_type: "consolidation" }]; },
  } as unknown as HindsightClient;
  const direct = await collectHindsightStatus(config, executor, statusClient);
  assert.deepEqual(direct.importer, { queued: 2, submitted: 1, processing: 3, failed: 4, cleanupPending: 5 });
  assert.equal(direct.service.documents, 42);
  assert.equal(direct.service.consolidationActive, true);
  assert.deepEqual(direct.issues, []);
  assert.doesNotMatch(JSON.stringify(direct), /token|password/i);

  (statusClient as any).listOperations = async () => [{ id: "op-2", status: "processing", task_type: "retain" }];
  const retaining = await collectHindsightStatus(config, executor, statusClient);
  assert.equal(retaining.service.processingOperations, 1);
  assert.equal(retaining.service.consolidationActive, false);

  let listener: ((data: unknown) => void) | undefined;
  let removed = false;
  const fakePi: any = {
    exec: executor.exec,
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        assert.equal(channel, HINDSIGHT_STATUS_REQUEST_EVENT);
        listener = handler;
        return () => { removed = true; };
      },
    },
  };
  const unregister = registerHindsightStatusProvider(fakePi, config, statusClient);
  let response: Promise<HindsightStatusSnapshotV1> | undefined;
  listener?.({ protocolVersion: 1, respond(value: Promise<HindsightStatusSnapshotV1>) { response = value; } });
  assert.equal((await response)?.service.documents, 42);
  unregister();
  assert.equal(removed, true);
});

test("empty memory search queries fail before contacting Hindsight", async () => {
  let calls = 0;
  const hindsight = new HindsightClient({ apiUrl: "http://example.test", environmentFile: "/unused", bankId: "coding-history", apiTokenFile: "/unused", requestTimeoutMs: 1000, retainWallTimeoutMs: 1000, recallMaxTokens: 2500, recallChunksMaxTokens: 2500, recallSourceFactsMaxTokens: 1500, operationPollMs: 1, operationPollTimeoutMs: 1000, operationRetentionDays: 14 }, async () => { calls += 1; return new Response("{}", { status: 200 }); }, "token");
  const tool = createMemorySearchTool(hindsight);
  await assert.rejects(() => tool.execute("call", { query: "   " }, undefined, undefined, {} as any), /must not be empty/);
  assert.equal(calls, 0);
});

test("extension source has no automatic retrieval lifecycle handlers", async () => {
  const source = await fs.readFile(path.resolve("src/extension/index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(source, /pi\.on\("context"/);
});
