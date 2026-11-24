import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { withStateLock, withWriterLock } from "../../src/importer/lock.js";

const writerBusy = /Importer writer lock is busy .*; stop pi-hindsight-importer first/;

test("state locks release on database setup and command failures without replacing the sidecar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-lock-"));
  const config = defaultConfig(root);
  const lockPath = `${config.stateDatabase}.writer-lock`;
  try {
    await withWriterLock(config.stateDatabase, () => undefined);
    await assert.rejects(fs.access(config.stateDatabase), { code: "ENOENT" });
    const initial = await fs.stat(lockPath);
    assert.equal(initial.mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(lockPath))).mode & 0o777, 0o700);

    await fs.writeFile(config.stateDatabase, "not a database");
    await assert.rejects(withStateLock(config, () => assert.fail("must not run")), /file is not a database/);
    await fs.rm(config.stateDatabase);
    await assert.rejects(withStateLock(config, () => { throw new Error("command failed"); }), /command failed/);
    await withStateLock(config, async () => {
      await assert.rejects(withStateLock(config, () => assert.fail("must not run")), writerBusy);
    });
    assert.equal((await fs.stat(lockPath)).ino, initial.ino);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("configs with different state directories contend for one resolved database", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-lock-alias-"));
  const config = defaultConfig(root);
  const alias = { ...config, stateDirectory: path.join(root, "other"), stateDatabase: path.join(root, "alias.sqlite3") };
  try {
    await withStateLock(config, async () => {
      await fs.symlink(config.stateDatabase, alias.stateDatabase);
      await assert.rejects(withStateLock(alias, () => assert.fail("must not run")), writerBusy);
    });
    await withStateLock(alias, () => undefined);
    await assert.rejects(fs.access(`${alias.stateDatabase}.writer-lock`), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
