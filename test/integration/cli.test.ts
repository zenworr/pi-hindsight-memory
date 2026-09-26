import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    assert.equal(run("config", "--check").status, 1);
    await assert.rejects(fs.access(state));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
