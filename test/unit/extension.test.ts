import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HindsightClient } from "../../src/hindsight/client.js";
import piHindsightMemory, { createMemorySearchTool } from "../../src/extension/index.js";
import { markerName, writeDirtyMarker } from "../../src/importer/dirty-markers.js";

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
    };
    piHindsightMemory(fakePi);
    assert.throws(() => start?.({}, {}), /already registered by \/other\/extension\.ts/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("empty memory search queries fail before contacting Hindsight", async () => {
  let calls = 0;
  const hindsight = new HindsightClient({ apiUrl: "http://example.test", environmentFile: "/unused", bankId: "coding-history", apiTokenFile: "/unused", requestTimeoutMs: 1000, retainWallTimeoutMs: 1000, recallMaxTokens: 2500, recallChunksMaxTokens: 2500, recallSourceFactsMaxTokens: 1500, operationPollMs: 1, operationPollTimeoutMs: 1000, operationRetentionDays: 14 }, async () => { calls += 1; return new Response("{}", { status: 200 }); }, "token");
  const tool = createMemorySearchTool(hindsight);
  await assert.rejects(() => tool.execute("call", { query: "   " }, undefined, undefined, {} as any), /must not be empty/);
  assert.equal(calls, 0);
});

test("dirty markers are atomic and contain no transcript text", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-marker-"));
  const sessionFile = "/home/test/session.jsonl";
  assert.equal(writeDirtyMarker(directory, { source: "pi", sessionFile, sessionId: "s1", reason: "session_shutdown" }), true);
  const marker = path.join(directory, "pi", markerName(sessionFile));
  const content = JSON.parse(await fs.readFile(marker, "utf8"));
  assert.deepEqual(content.session_file, sessionFile);
  assert.equal(content.transcript, undefined);
  await fs.rm(directory, { recursive: true, force: true });
});

test("10,000 dirty-marker writes stay within the foreground budget", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-marker-perf-"));
  const samples: number[] = [];
  for (let index = 0; index < 10_000; index += 1) {
    const started = process.hrtime.bigint();
    writeDirtyMarker(directory, { source: "pi", sessionFile: `/home/test/session-${index % 10}.jsonl`, sessionId: `s-${index % 10}`, reason: "session_compact" });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.floor(samples.length * 0.5)]! < 10);
  assert.ok(samples[Math.floor(samples.length * 0.99)]! < 50);
  // Hosted CI runners can suspend the process between the two clock reads.
  if (!process.env.CI) assert.ok(samples.at(-1)! < 250);
  await fs.rm(directory, { recursive: true, force: true });
});

test("extension source has no automatic retrieval lifecycle handlers", async () => {
  const source = await fs.readFile(path.resolve("src/extension/index.ts"), "utf8");
  assert.doesNotMatch(source, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(source, /pi\.on\("context"/);
});
