import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "../../src/common/config.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { scan } from "../../src/importer/scanner.js";
import { searchEvidence } from "../../src/importer/evidence.js";
import { retrieveMemory } from "../../src/extension/retrieve.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { stripHarnessContext } from "../../src/canonical/injected-memory.js";
import { HindsightClient } from "../../src/hindsight/client.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-evidence-"));
  const config = defaultConfig(root);
  config.sourceRoots.pi = path.join(root, "pi");
  config.sessionSettleSeconds = 0;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  const file = path.join(config.sourceRoots.pi, "session.jsonl");
  const message = (id: string, parentId: string | null, role: string, content: unknown, seconds: number) => ({ type: "message", id, parentId, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), message: { role, content } });
  const records = [
    { type: "session", version: 3, id: "source-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    message("context", null, "user", "# AGENTS.md instructions for /synthetic\n\n<INSTRUCTIONS>INJECTED-CANARY</INSTRUCTIONS>", 1),
    message("user-a", "context", "user", "Preserve the local Hindsight stack for rollback.", 2),
    message("call", "user-a", "assistant", [{ type: "toolCall", name: "memory_search", arguments: { query: "rollback" } }], 3),
    message("reply-a", "call", "assistant", [{ type: "text", text: "A short intermediate reply." }], 4),
    message("reply-b", "reply-a", "assistant", [{ type: "text", text: "DERIVED-CANARY about the rollback." }], 5),
    message("user-b", "reply-b", "user", "Correction: the local Hindsight stack was removed. Current rollback uses logical backups.", 6),
    message("reply-c", "user-b", "assistant", [{ type: "text", text: "The requested recovery method is logical backups." }], 7),
  ];
  const source = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.writeFile(file, source);
  const state = new StateDatabase(config.stateDatabase);
  return { root, config, file, source, state, async close() { state.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test("known startup wrappers are removed without dropping genuine user quotations", () => {
  assert.equal(stripHarnessContext("<environment_context>generated</environment_context>\nGenuine request"), "Genuine request");
  const quote = "Please explain this configuration:\n<environment_context>quoted</environment_context>";
  assert.equal(stripHarnessContext(quote), quote);
  assert.equal(stripHarnessContext("# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>generated</INSTRUCTIONS>\nGenuine request"), "Genuine request");
  assert.equal(stripHarnessContext("# AGENTS.md instructions\n<INSTRUCTIONS>generated</INSTRUCTIONS>\nGenuine request"), "Genuine request");
});

test("transcript evidence is private, idempotent, source-linked, and labels derived replies", async () => {
  const f = await fixture();
  try {
    const result = await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    assert.equal(result.queued, 0);
    assert.equal(f.state.listGenerations().length, 0);
    assert.equal((await fs.stat(f.config.evidenceDatabase)).mode & 0o777, 0o600);
    const hits = searchEvidence(f.config, "current Hindsight rollback logical backups").hits;
    assert.equal(hits[0]?.entryId, "user-b");
    assert.equal(hits[0]?.documentId, "agent-session:pi:source-session");
    assert.match(hits[0]!.text, /stack was removed/);
    assert.equal(searchEvidence(f.config, "INJECTED-CANARY").hits.length, 0);
    assert.equal(searchEvidence(f.config, "DERIVED-CANARY").hits[0]?.provenance, "memory-assisted");
    const count = () => {
      const db = new DatabaseSync(f.config.evidenceDatabase, { readOnly: true });
      try { return db.prepare("SELECT count(*) AS count FROM passages").get()!.count; } finally { db.close(); }
    };
    const before = count();
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    assert.equal(count(), before);
    assert.equal(await fs.readFile(f.file, "utf8"), f.source);
    const adapter = new PiAdapter(f.config.sourceRoots.pi);
    const ref = (await adapter.discover()[Symbol.asyncIterator]().next()).value!;
    const session = await adapter.load(ref, { spoolDirectory: f.config.spoolDirectory, maxCanonicalBytes: f.config.maxCanonicalBytes });
    const turns = (await session.readContent()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(turns.find((turn) => turn.native_entry_id === "reply-b").provenance, "memory-assisted");
    assert.equal(turns.find((turn) => turn.native_entry_id === "reply-c").provenance, "original");
    await session.cleanup();
  } finally { await f.close(); }
});

test("retrieval keeps original evidence available during a Hindsight outage", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    const client = { recall: async () => { throw new Error("remote unavailable"); } } as unknown as HindsightClient;
    const result = await retrieveMemory(f.config, client, "Hindsight rollback logical backups");
    assert.match(result.text, /Only local evidence is shown/);
    assert.match(result.text, /stack was removed/);
    assert.equal(result.details.degraded, true);
    assert.ok(result.details.sourceEvidenceCount! > 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => retrieveMemory(f.config, client, "Hindsight rollback", controller.signal), /abort/i);
  } finally { await f.close(); }
});

test("reviewed corrections are dated, cited, and separate from derived matches", async () => {
  const f = await fixture();
  try {
    await scan(f.config, f.state, { source: "pi", force: true, indexOnly: true });
    await fs.mkdir(path.dirname(f.config.reviewedFactsFile), { recursive: true });
    await fs.writeFile(f.config.reviewedFactsFile, JSON.stringify([{ key: "rollback", text: "Hindsight rollback uses logical backups.", source: "source-session entry user-b", verifiedAt: "2026-01-01T00:00:06.000Z", supersedes: "The local stack remains available." }]), { mode: 0o600 });
    const client = { recall: async () => ({ results: [{ text: "The local stack remains available.", scores: { final: 1 }, document_id: "agent-session:pi:source-session" }] }) } as unknown as HindsightClient;
    const result = await retrieveMemory(f.config, client, "current Hindsight rollback");
    assert.ok(result.text.indexOf("Reviewed facts") < result.text.indexOf("Hindsight-derived"));
    assert.match(result.text, /Superseded: The local stack/);
    assert.match(result.text, /Verified: 2026-01-01T00:00:06.000Z/);
    assert.equal(result.details.reviewedFactCount, 1);
    const missing = await retrieveMemory(f.config, { recall: async () => ({ results: [] }) } as any, "UnrecordedZirconAsterNavigation");
    assert.equal(missing.details.noMatch, true);
  } finally { await f.close(); }
});
