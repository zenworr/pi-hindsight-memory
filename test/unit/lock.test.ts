import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { withStateLock } from "../../src/importer/lock.js";

test("state locks release on database setup and command failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-lock-"));
  const config = defaultConfig(root);
  const lockPath = path.join(config.stateDirectory, "daemon.lock");
  try {
    await fs.mkdir(config.stateDirectory, { recursive: true });
    await fs.writeFile(config.stateDatabase, "not a database");
    await assert.rejects(withStateLock(config, async () => assert.fail("must not run")));
    await assert.rejects(fs.access(lockPath));
    await fs.rm(config.stateDatabase);
    await assert.rejects(withStateLock(config, async () => { throw new Error("command failed"); }), /command failed/);
    await assert.rejects(fs.access(lockPath));
    await withStateLock(config, async () => {
      await assert.rejects(withStateLock(config, async () => undefined), /already running/);
      await fs.access(lockPath);
    });
    await assert.rejects(fs.access(lockPath));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
