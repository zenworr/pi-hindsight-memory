import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PiAdapter } from "../../src/adapters/pi.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { forEachJsonLine, MalformedJsonLineError } from "../../src/adapters/adapter.js";

const fixtureRoot = path.resolve("test/fixtures");
async function tempDirectory(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-adapter-")); }
async function loadOne(adapter: { discover(): AsyncIterable<any>; load(ref: any, options: any): Promise<any> }, source: string, id: string, spoolDirectory: string) {
  for await (const ref of adapter.discover()) if (ref.nativeSessionId === id) return adapter.load(ref, { spoolDirectory, maxCanonicalBytes: 10_000_000 });
  throw new Error(`fixture ${source}:${id} not found`);
}
function lines(content: string): Array<Record<string, unknown>> { return content.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>); }

test("Pi adapter preserves branch links, excludes derived content, and marks memory-assisted assistant prose", async () => {
  const directory = await tempDirectory();
  const session = await loadOne(new PiAdapter(path.join(fixtureRoot, "pi")), "pi", "pi-fixture-001", directory);
  try {
    const output = await fs.readFile(session.contentPath, "utf8");
    assert.match(output, /REF-ID: agent-session:pi:pi-fixture-001/);
    assert.match(output, /PostgreSQL/);
    assert.match(output, /Read src\/db\.ts/);
    assert.match(output, /"provenance":"memory-assisted"/);
    assert.doesNotMatch(output, /SECRET_TOOL_OUTPUT|Generated summary|Generated memory|Found old memory/);
    const parsed = lines(output);
    const assisted = parsed.find((entry) => entry.content === "The earlier decision supports PostgreSQL.");
    assert.equal(assisted?.provenance, "memory-assisted");
    assert.equal(assisted?.parent_entry_id, "tool-2");
  } finally { await session.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Pi and Codex adapters classify explicit subagent sessions", async () => {
  const directory = await tempDirectory();
  const piRoot = path.join(directory, "pi");
  const piPath = path.join(piRoot, "parent", "2026-01-01T00-00-00-000Z_parent", "entry-1", "run-0", "session.jsonl");
  await fs.mkdir(path.dirname(piPath), { recursive: true });
  await fs.writeFile(piPath, '{"type":"session","version":3,"id":"pi-sub","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"session_info","name":"subagent-builder-entry-1-1","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  await fs.writeFile(path.join(piRoot, "modern.jsonl"), '{"type":"session","version":3,"id":"pi-modern","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n{"type":"session_info","name":"future-agent#deadbeef","id":"info-2","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  await fs.writeFile(path.join(piRoot, "fork.jsonl"), '{"type":"session","version":3,"id":"pi-fork","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"/history/parent.jsonl"}\n', "utf8");
  await fs.writeFile(path.join(piRoot, "orphan-name.jsonl"), '{"type":"session","version":3,"id":"pi-orphan-name","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"session_info","name":"future-agent#0123abcd","id":"info-3","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  await fs.writeFile(path.join(piRoot, "primary.jsonl"), '{"type":"session","version":3,"id":"pi-primary","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test"}\n{"type":"session_info","name":"normal-user-session","id":"info-4","parentId":null,"timestamp":"2026-01-01T00:00:00.001Z"}\n', "utf8");
  const taskPath = path.join(piRoot, "parent", "tasks", "task.jsonl");
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.writeFile(taskPath, '{"type":"session","version":3,"id":"pi-task","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/test","parentSession":"pi-primary"}\n', "utf8");
  const pi = new PiAdapter(piRoot);
  const piRefs = []; for await (const ref of pi.discover()) piRefs.push(ref);
  const piById = new Map(piRefs.map((ref) => [ref.nativeSessionId, ref]));
  assert.equal(piById.get("pi-sub")?.classification?.kind, "subagent");
  assert.equal(piById.get("pi-modern")?.classification?.kind, "subagent");
  assert.equal(piById.get("pi-modern")?.classification?.reason, "pi-parent-session-and-generated-agent-name");
  assert.equal(piById.get("pi-modern")?.classification?.parentSessionId, "/history/parent.jsonl");
  assert.equal(piById.get("pi-modern")?.classification?.policyVersion, "3");
  assert.equal(piById.get("pi-fork")?.classification?.kind, "ambiguous");
  assert.equal(piById.get("pi-orphan-name")?.classification?.kind, "ambiguous");
  assert.equal(piById.get("pi-task")?.classification?.kind, "subagent");
  assert.equal(piById.get("pi-task")?.classification?.reason, "pi-parent-session-and-task-child-layout");
  assert.equal(piById.get("pi-primary")?.classification?.kind, "primary");

  const codexRoot = path.join(directory, "codex");
  await fs.mkdir(codexRoot, { recursive: true });
  const codexPath = path.join(codexRoot, "rollout-2026-01-01T00-00-00-000-000000000000000000000000.jsonl");
  await fs.writeFile(codexPath, '{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"session_id":"thread-sub","id":"rollout-sub","source":"subagent","cwd":"/home/test"}}\n', "utf8");
  await fs.writeFile(path.join(codexRoot, "rollout-2026-01-01T00-00-01-000-000000000000000000000001.jsonl"), '{"timestamp":"2026-01-01T00:00:01.000Z","type":"session_meta","payload":{"session_id":"thread-nested","source":{"subagent":"review"},"parent_thread_id":"thread-sub","cwd":"/home/test"}}\n', "utf8");
  await fs.writeFile(path.join(codexRoot, "rollout-2026-01-01T00-00-02-000-000000000000000000000002.jsonl"), '{"timestamp":"2026-01-01T00:00:02.000Z","type":"session_meta","payload":{"session_id":"thread-null","source":{"subagent":null},"parent_thread_id":"thread-primary","cwd":"/home/test"}}\n', "utf8");
  await fs.writeFile(path.join(codexRoot, "rollout-2026-01-01T00-00-03-000-000000000000000000000003.jsonl"), '{"timestamp":"2026-01-01T00:00:03.000Z","type":"session_meta","payload":{"session_id":"thread-object-drift","source":{"future_child":{}},"cwd":"/home/test"}}\n', "utf8");
  await fs.writeFile(path.join(codexRoot, "rollout-2026-01-01T00-00-04-000-000000000000000000000004.jsonl"), '{"timestamp":"2026-01-01T00:00:04.000Z","type":"session_meta","payload":{"session_id":"thread-source-drift","source":"future-client","cwd":"/home/test"}}\n', "utf8");
  const unknownMetaPath = path.join(codexRoot, "rollout-2026-01-01T00-00-05-000-000000000000000000000005.jsonl");
  await fs.writeFile(unknownMetaPath, '{"timestamp":"2026-01-01T00:00:05.000Z","type":"future_session_meta","payload":{"session_id":"thread-unknown-meta","source":"exec","cwd":"/home/test"}}\n', "utf8");
  const codex = new CodexAdapter(codexRoot);
  const codexRefs = []; for await (const ref of codex.discover()) codexRefs.push(ref);
  const codexById = new Map(codexRefs.map((ref) => [ref.nativeSessionId, ref]));
  assert.equal(codexById.get("rollout-sub")?.classification?.kind, "subagent");
  assert.equal(codexById.get("thread-nested")?.classification?.kind, "subagent");
  assert.equal(codexById.get("thread-null")?.classification?.kind, "ambiguous");
  assert.equal(codexById.get("thread-object-drift")?.classification?.kind, "ambiguous");
  assert.equal(codexById.get("thread-source-drift")?.classification?.kind, "ambiguous");
  assert.equal(codexRefs.find((ref) => ref.locator === unknownMetaPath)?.classification?.kind, "ambiguous");
  await fs.rm(directory, { recursive: true, force: true });
});

test("Codex adapter keeps visible prose and actions but drops reasoning, developer, and outputs", async () => {
  const directory = await tempDirectory();
  const session = await loadOne(new CodexAdapter(path.join(fixtureRoot, "codex")), "codex", "codex-rollout-001", directory);
  try {
    const output = await fs.readFile(session.contentPath, "utf8");
    assert.match(output, /Node's test runner/);
    assert.match(output, /Search prior memory/);
    assert.match(output, /"provenance":"memory-assisted"/);
    assert.doesNotMatch(output, /Do not import this output|Developer instructions|Hidden reasoning/);
  } finally { await session.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Claude adapter keeps text and compact actions while excluding thinking, sidechains, and tool results", async () => {
  const directory = await tempDirectory();
  const session = await loadOne(new ClaudeAdapter(path.join(fixtureRoot, "claude")), "claude", "claude-fixture-001", directory);
  try {
    const output = await fs.readFile(session.contentPath, "utf8");
    assert.match(output, /simple implementation/);
    assert.match(output, /Read src\/index\.ts/);
    assert.match(output, /"provenance":"memory-assisted"/);
    assert.doesNotMatch(output, /hidden thinking|sidechain must not|tool output must not/);
    const parsed = lines(output);
    assert.ok(parsed.every((entry) => entry.role !== "user" || entry.provenance === undefined));
  } finally { await session.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("Claude classification remains artifact-scoped for shared session IDs", async () => {
  const directory = await tempDirectory();
  const root = path.join(directory, "claude");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "primary.jsonl"), '{"sessionId":"shared-session","uuid":"primary-1","parentUuid":null,"timestamp":"2026-01-01T00:00:00.000Z","isSidechain":false,"type":"user","message":{"role":"user","content":"primary"}}\n', "utf8");
  await fs.writeFile(path.join(root, "agent-child.jsonl"), '{"sessionId":"shared-session","uuid":"child-1","parentUuid":"primary-1","timestamp":"2026-01-01T00:00:01.000Z","isSidechain":true,"type":"assistant","message":{"role":"assistant","content":"child"}}\n', "utf8");
  await fs.writeFile(path.join(root, "agent-marker.jsonl"), '{"sessionId":"marker-session","uuid":"child-2","parentUuid":null,"timestamp":"2026-01-01T00:00:02.000Z","agentId":"agent-2","type":"assistant","message":{"role":"assistant","content":"child"}}\n', "utf8");
  await fs.writeFile(path.join(root, "plain-marker.jsonl"), '{"sessionId":"ambiguous-session","uuid":"child-3","parentUuid":null,"timestamp":"2026-01-01T00:00:03.000Z","agentId":"agent-3","type":"assistant","message":{"role":"assistant","content":"unknown"}}\n', "utf8");
  const refs = []; for await (const ref of new ClaudeAdapter(root).discover()) refs.push(ref);
  assert.equal(refs.length, 4);
  assert.equal(refs.find((ref) => ref.locator.endsWith("primary.jsonl"))?.classification?.kind, "primary");
  assert.equal(refs.find((ref) => ref.locator.endsWith("agent-child.jsonl"))?.classification?.kind, "subagent");
  assert.equal(refs.find((ref) => ref.locator.endsWith("agent-marker.jsonl"))?.classification?.kind, "subagent");
  assert.equal(refs.find((ref) => ref.locator.endsWith("plain-marker.jsonl"))?.classification?.kind, "ambiguous");
  assert.equal(refs.filter((ref) => ref.nativeSessionId === "shared-session").length, 2);
  await fs.rm(directory, { recursive: true, force: true });
});

test("active JSONL final tail is ignored and completed malformed lines fail closed", async () => {
  const directory = await tempDirectory();
  const active = path.join(directory, "active.jsonl");
  await fs.writeFile(active, '{"ok":1}\n{"partial":', "utf8");
  const values: unknown[] = [];
  await forEachJsonLine(active, (value) => { values.push(value); });
  assert.deepEqual(values, [{ ok: 1 }]);
  await fs.writeFile(active, '{"ok":1}\n{"complete":true}', "utf8");
  const withoutTrailingNewline: unknown[] = [];
  await forEachJsonLine(active, (value) => { withoutTrailingNewline.push(value); });
  assert.deepEqual(withoutTrailingNewline, [{ ok: 1 }]);
  await fs.appendFile(active, "\n", "utf8");
  const afterCompletion: unknown[] = [];
  await forEachJsonLine(active, (value) => { afterCompletion.push(value); });
  assert.deepEqual(afterCompletion, [{ ok: 1 }, { complete: true }]);
  const malformed = path.join(directory, "malformed.jsonl");
  await fs.writeFile(malformed, '{"ok":1}\nnot-json\n', "utf8");
  await assert.rejects(() => forEachJsonLine(malformed, () => undefined), MalformedJsonLineError);
  await fs.rm(directory, { recursive: true, force: true });
});

test("OpenCode schema drift without classification columns fails closed", async () => {
  const directory = await tempDirectory();
  const dbPath = path.join(directory, "opencode.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?)").run("unknown-schema", 1760000000000, 1760000000000);
  writer.close();
  const refs = []; for await (const ref of new OpenCodeAdapter(dbPath).discover()) refs.push(ref);
  assert.equal(refs[0]?.classification?.kind, "ambiguous");
  assert.equal(refs[0]?.classification?.reason, "opencode-missing-classification-columns");
  await fs.rm(directory, { recursive: true, force: true });
});

test("OpenCode adapter reads a consistent read-only database and preserves per-session identity", async () => {
  const directory = await tempDirectory();
  const dbPath = path.join(directory, "opencode.db");
  const writer = new DatabaseSync(dbPath);
  writer.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-1", null, "global", "/home/test", "Fixture", "1", "build", "model", 1760000000000, 1760000001000, null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-child", "ses-1", "global", "/home/test", "Fixture (@general subagent)", "1", "general", "model", 1760000000200, 1760000000200, null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-grandchild", "ses-child", "global", "/home/test", "Fixture (@review subagent)", "1", "review", "model", 1760000000300, 1760000000300, null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-user-fork", "ses-1", "global", "/home/test", "Discuss subagent architecture", "1", "build", "model", 1760000000400, 1760000000400, null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-root-word", null, "global", "/home/test", "Subagent usage notes", "1", "build", "model", 1760000000500, 1760000000500, null);
  writer.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-orphan-generated", null, "global", "/home/test", "Fixture (@future subagent)", "1", "future", "model", 1760000000600, 1760000000600, null);
  writer.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg-1", "ses-1", 1760000000100, 1760000000100, JSON.stringify({ role: "user", time: { created: 1760000000100 } }));
  writer.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("part-1", "msg-1", "ses-1", 1760000000100, 1760000000100, JSON.stringify({ type: "text", text: "Use SQLite FTS5." }));
  writer.close();
  const before = await fs.readFile(dbPath);
  const adapter = new OpenCodeAdapter(dbPath);
  const refs = []; for await (const ref of adapter.discover()) refs.push(ref);
  assert.equal(refs.find((ref) => ref.nativeSessionId === "ses-child")?.classification?.kind, "subagent");
  assert.equal(refs.find((ref) => ref.nativeSessionId === "ses-grandchild")?.classification?.kind, "subagent");
  assert.equal(refs.find((ref) => ref.nativeSessionId === "ses-user-fork")?.classification?.kind, "ambiguous");
  assert.equal(refs.find((ref) => ref.nativeSessionId === "ses-root-word")?.classification?.kind, "primary");
  assert.equal(refs.find((ref) => ref.nativeSessionId === "ses-orphan-generated")?.classification?.kind, "ambiguous");
  const directory2 = path.join(directory, "spool");
  const session = await loadOne(adapter, "opencode", "ses-1", directory2);
  try {
    const output = await fs.readFile(session.contentPath, "utf8");
    assert.match(output, /Use SQLite FTS5/);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(Number((check.prepare("PRAGMA query_only").get() as any).query_only), 0);
    check.close();
    assert.deepEqual(await fs.readFile(dbPath), before);
  } finally { await session.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
});
