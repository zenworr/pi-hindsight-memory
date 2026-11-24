import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withWriterLock } from "../../src/importer/lock.js";
import { StateDatabase } from "../../src/importer/state-db.js";

const lockModule = new URL("../../src/importer/lock.js", import.meta.url);
const contenderCode = `
  import { once } from "node:events";
  const { withWriterLock } = await import(process.argv[1]);
  const start = once(process, "message");
  process.send("ready");
  await start;
  try {
    await withWriterLock(process.argv[2], () => {
      const hold = once(process, "disconnect");
      process.send("entered");
      return hold;
    });
  } catch (error) { process.send(error.message); }
`;

function startContender(databasePath: string, signal: AbortSignal) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", contenderCode, lockModule.href, databasePath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  return { child, closed: once(child, "close"), ready: once(child, "message", { signal }) };
}

test("only one child acquires the writer lock, readers stay available, and SIGKILL releases it", { timeout: 20_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-writer-race-"));
  const contenders: ReturnType<typeof startContender>[] = [];
  try {
    const filename = path.join(root, "state", "database.sqlite3");
    const aliasDirectory = path.join(root, "alias");
    const state = new StateDatabase(filename);
    state.close();
    await fs.symlink(path.dirname(filename), aliasDirectory, "dir");
    const alias = path.join(aliasDirectory, path.basename(filename));
    for (let i = 0; i < 8; i++) contenders.push(startContender(i % 2 ? alias : filename, t.signal));
    for (const [message] of await Promise.all(contenders.map(({ ready }) => ready))) assert.equal(message, "ready");
    const attempts = contenders.map(({ child }) => once(child, "message", { signal: t.signal }));
    for (const { child } of contenders) child.send("start");
    const winners = (await Promise.all(attempts)).flatMap(([message], i) => {
      if (message === "entered") return [contenders[i]!];
      assert.match(String(message), /Importer writer lock is busy/);
      return [];
    });
    assert.equal(winners.length, 1);
    const [winner] = winners;
    assert.ok(winner);
    await assert.rejects(withWriterLock(filename, () => assert.fail("must not run")), /Importer writer lock is busy/);
    const reader = new StateDatabase(alias, { readOnly: true });
    try { assert.equal(reader.pendingWorkCount(3), 0); }
    finally { reader.close(); }

    assert.ok(winner.child.kill("SIGKILL"));
    assert.deepEqual(await winner.closed, [null, "SIGKILL"]);
    await withWriterLock(filename, () => undefined);
  } finally {
    for (const { child } of contenders) child.kill("SIGKILL");
    await Promise.allSettled(contenders.map(({ closed }) => closed));
    await fs.rm(root, { recursive: true, force: true });
  }
});
