import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PiAdapter } from "../../dist/src/adapters/pi.js";
import { CodexAdapter } from "../../dist/src/adapters/codex.js";
import { ClaudeAdapter } from "../../dist/src/adapters/claude.js";
import { OpenCodeAdapter } from "../../dist/src/adapters/opencode.js";
import { DEFAULT_MAX_CANONICAL_BYTES } from "../../dist/src/common/limits.js";
import { SOURCES } from "../../dist/src/common/types.js";
import { StateDatabase } from "../../dist/src/importer/state-db.js";

async function stat(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function copyDatabase(file, directory) {
  if (!(await stat(file))?.isFile() || await stat(`${file}-wal`) || await stat(`${file}-journal`)) throw new Error("Expected a standalone SQLite backup");
  const copy = path.join(directory, path.basename(file));
  await fs.copyFile(file, copy);
  return copy;
}

async function adapterFor(source, root, scratch) {
  const file = path.join(root, source === "opencode" ? "opencode.db" : source);
  if (source === "opencode") {
    if (!(await stat(file))?.isFile()) return;
    return new OpenCodeAdapter(await copyDatabase(file, scratch));
  }
  if (!(await stat(file))?.isDirectory()) return;
  if (source === "pi") return new PiAdapter(file);
  if (source === "claude") return new ClaudeAdapter(file);
  if (source === "codex") return new CodexAdapter(file, await copyDatabase(path.join(root, "state_5.sqlite"), scratch));
  throw new Error("Unsupported source");
}

async function report(statePath, sourcesPath, scratch) {
  const state = new StateDatabase(await copyDatabase(statePath, scratch), { readOnly: true });
  const counts = { acknowledged: 0, unchanged: 0, changed: 0, preservedAmbiguous: 0, sourceMissing: 0, unavailable: 0, errors: 0 };
  try {
    const groups = new Map();
    for (const session of state.listSessions()) {
      if (!session.acknowledgedHash) continue;
      counts.acknowledged++;
      if (session.status === "ambiguous_preserved") { counts.preservedAmbiguous++; continue; }
      const origin = session.sourceOrigin ?? "desktop";
      if (!/^[a-zA-Z0-9_-]+$/.test(origin) || !SOURCES.includes(session.source)) throw new Error("Invalid source identity");
      const key = `${origin}/${session.source}`;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(session.nativeSessionId, session);
    }
    for (const [key, sessions] of groups) {
      const [origin, source] = key.split("/");
      const root = path.join(sourcesPath, origin);
      let adapter;
      const spoolDirectory = await fs.mkdtemp(path.join(scratch, "spool-"));
      try {
        if ((await stat(root))?.isDirectory()) adapter = await adapterFor(source, root, spoolDirectory);
        if (adapter) {
          const references = new Map();
          for await (const reference of adapter.discover()) {
            if (!sessions.has(reference.nativeSessionId)) continue;
            references.set(reference.nativeSessionId, references.has(reference.nativeSessionId) ? undefined : reference);
          }
          for (const [id, reference] of references) {
            const previous = sessions.get(id);
            sessions.delete(id);
            try {
              if (!reference || (reference.classification ?? await adapter.classify(reference)).kind !== "primary") { counts.unavailable++; continue; }
              const session = await adapter.load(reference, { spoolDirectory, maxCanonicalBytes: DEFAULT_MAX_CANONICAL_BYTES });
              await session.cleanup();
              counts[session.canonicalHash === previous.acknowledgedHash ? "unchanged" : "changed"]++;
            } catch { counts.errors++; }
          }
        }
        for (const previous of sessions.values()) counts[previous.status === "source_missing" ? "sourceMissing" : "unavailable"]++;
      } catch { counts.errors += sessions.size; }
    }
    return counts;
  } finally { state.close(); }
}

try {
  const { values } = parseArgs({ options: { "state-copy": { type: "string" }, "sources-copy": { type: "string" } } });
  if (!values["state-copy"] || !values["sources-copy"]) throw new Error("Both copies are required");
  const statePath = path.resolve(values["state-copy"]);
  const sourcesPath = path.resolve(values["sources-copy"]);
  const state = await stat(statePath);
  const sources = await stat(sourcesPath);
  if (!state?.isFile() || (state.mode & 0o077) || !sources?.isDirectory() || (sources.mode & 0o077)) throw new Error("Copies must be private");
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-redaction-impact-"));
  let counts;
  try { counts = await report(statePath, sourcesPath, scratch); }
  finally { await fs.rm(scratch, { recursive: true, force: true }); }
  process.stdout.write(`${JSON.stringify(counts)}\n`);
  if (counts.errors || counts.unavailable) process.exitCode = 1;
} catch {
  process.stdout.write('{"errors":1}\n');
  process.exitCode = 1;
}
