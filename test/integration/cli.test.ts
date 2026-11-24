import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StateDatabase } from "../../src/importer/state-db.js";
import { withWriterLock } from "../../src/importer/lock.js";

const cli = fileURLToPath(new URL("../../src/importer/cli.js", import.meta.url));

test("CLI configuration checks are offline and invalid options cannot create importer state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cli-"));
  const file = path.join(root, "config.json");
  const state = path.join(root, "state.sqlite3");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, PI_HINDSIGHT_CONFIG: file, PI_HINDSIGHT_REQUIRE_APPROVAL: "1" }, timeout: 10_000 });
  try {
    await fs.writeFile(file, JSON.stringify({ stateDatabase: state, hindsight: { apiUrl: "http://127.0.0.1:1" } }));
    const checked = run("config", "--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), { valid: true, configPath: file });
    assert.equal(run("scan", "--limit=NaN").status, 1);
    assert.equal(run("scan", "--source=unknown").status, 1);
    assert.equal(run("daemon", "--once", "--typo").status, 1);
    await assert.rejects(fs.access(state));
    await fs.writeFile(file, "invalid JSON");
    const defaults = run("config", "--defaults");
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(JSON.parse(defaults.stdout).importer.maxAttempts, 3);
    assert.equal(run("scan", "--help").status, 0);
    assert.match(run("repair").stderr, /repair requires --plan FILE/);
    assert.match(run("cleanup-subagents", "--plan", "unused.json").stderr, /cleanup-subagents requires --apply/);
    assert.match(run("cleanup-subagents", "--apply").stderr, /cleanup-subagents requires --plan FILE/);
    assert.equal(run("config", "--check").status, 1);
    await assert.rejects(fs.access(state));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI recovery commands show safe help, reject invalid options, and honor the writer lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-cli-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  const state = path.join(root, "state.sqlite3");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args, "--config", file], { encoding: "utf8", env: { ...process.env, HOME: root }, timeout: 10_000 });
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /spool-cleanup \[--apply\].*Preview/);
  assert.match(help.stdout, /retry-unresolved.*only after reviewing/);
  assert.equal(run("retry-unresolved", "--apply").status, 1);
  assert.equal(run("spool-cleanup", "--apply", "--apply").status, 1);
  await assert.rejects(fs.access(state));

  await fs.writeFile(file, JSON.stringify({ stateDatabase: state, hindsight: { apiUrl: "http://127.0.0.1:1" } }));
  new StateDatabase(state).close();
  await withWriterLock(state, () => {
    for (const command of ["retry-failed", "retry-unresolved", "spool-cleanup"]) {
      const locked = command === "retry-unresolved" ? run(command, "--operation", "reviewed-id") : run(command);
      assert.equal(locked.status, 1, locked.stderr);
      assert.match(locked.stderr, /writer lock is busy.*scripts\/importer-service\.sh stop/);
    }
  });
  const retry = run("retry-unresolved");
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { held: [] });
  for (const flags of [[], ["--apply"]]) {
    const clean = run("spool-cleanup", ...flags);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).apply, flags.length > 0);
  }
});
