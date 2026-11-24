import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { StateDatabase } from "../../src/importer/state-db.js";

const exec = promisify(execFile);
const linux = { skip: process.platform !== "linux" };

async function fixture(t: TestContext, failure?: "build" | "verify" | "migrate", legacyUnit = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-rollout-"));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  const config = path.join(dir, "config.json");
  const state = path.join(dir, "state.sqlite3");
  const evidence = path.join(dir, "evidence.sqlite3");
  const backups = path.join(dir, "backups");
  const snapshots = path.join(dir, "pi-hindsight-memory-cutover");
  const drops = path.join(dir, "systemd", "user", "pi-hindsight-importer.service.d");
  const drop = path.join(drops, "90-runtime.conf");
  const base = path.join(path.dirname(drops), "pi-hindsight-importer.service");
  const telemetry = path.join(drops, "10-telemetry.conf");
  const previous = path.join(dir, "previous.mjs");
  const pid = path.join(dir, "pid");
  const log = path.join(dir, "log");
  const launched = path.join(dir, "launched");
  const ready = path.join(dir, "ready");
  const env = {
    HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_STATE_HOME: dir,
    PATH: `${bin}:${process.env.PATH}`, PI_HINDSIGHT_NODE: process.execPath, PI_HINDSIGHT_CONFIG: config,
    PI_HINDSIGHT_BACKUP_DIR: backups, PI_HINDSIGHT_CONTAINER_ENGINE: "fixture-engine",
    ROLLOUT_ROOT: process.cwd(), ROLLOUT_FAILURE: failure ?? "", ROLLOUT_STATE: state, ROLLOUT_EVIDENCE: evidence,
    ROLLOUT_DROP: drop, ROLLOUT_BASE: base, ROLLOUT_LOG: log, ROLLOUT_PID: pid, ROLLOUT_LAUNCHED: launched, ROLLOUT_READY: ready,
    PI_HINDSIGHT_TELEMETRY_FILE: "/dev/null",
  };
  const ctl = (...args: string[]) => exec(path.join(bin, "systemctl"), ["--user", ...args], { env, timeout: 5_000 });
  t.after(async () => {
    await ctl("stop").catch(() => {});
    await exec("chmod", ["-R", "u+w", dir]);
    await fs.rm(dir, { recursive: true, force: true });
  });
  await Promise.all([fs.mkdir(bin), fs.mkdir(repo), fs.mkdir(drops, { recursive: true })]);
  await fs.cp(path.resolve("scripts"), path.join(repo, "scripts"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), '{"type":"module"}');
  const git = (...args: string[]) => exec("git", args, { cwd: repo, env });
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=Tester", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Build fixture");
  const rev = (await git("rev-parse", "HEAD")).stdout.trim();
  const runtime = path.join(snapshots, rev);

  const local = new StateDatabase(state);
  local.db.prepare("INSERT INTO scan_candidates (source, native_session_id, fingerprint, first_observed_at) VALUES ('pi','settling','fixture','now')").run();
  local.close();
  const index = new DatabaseSync(evidence);
  index.exec("CREATE TABLE documents(id TEXT PRIMARY KEY)");
  index.close();
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? "/", "http://localhost").pathname.split("/").at(-1);
    switch (target) {
      case "stats": res.end('{"pending_operations":0,"total_documents":0}'); break;
      case "operations": res.end('{"operations":[]}'); break;
      case "documents": res.end(failure && existsSync(launched) ? '{"total":1,"items":[{"id":"unexpected","content_hash":"different"}]}' : '{"total":0,"items":[]}'); break;
      case "config": res.end('{"config":{"enable_auto_consolidation":true}}'); break;
      default: res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.close(); });
  const apiTokenFile = path.join(dir, "token");
  await fs.writeFile(apiTokenFile, "fixture-token\n", { mode: 0o600 });
  await fs.writeFile(config, JSON.stringify({ stateDatabase: state, evidenceDatabase: evidence, hindsight: { apiTokenFile, bankId: "rollout-fixture", apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, httpMaxAttempts: 1 } }));
  const daemon = `import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { withWriterLock } from ${JSON.stringify(path.resolve("dist/src/importer/lock.js"))};
const env = process.env;
await withWriterLock(env.ROLLOUT_STATE, async () => {
  const db = new DatabaseSync(env.ROLLOUT_STATE);
  db.prepare("INSERT OR REPLACE INTO daemon_status (id,pid,heartbeat_at,phase) VALUES (1,?,?,'idle')").run(process.pid, new Date().toISOString());
  if (process.argv[1] !== ${JSON.stringify(previous)}) {
    const evidence = new DatabaseSync(env.ROLLOUT_EVIDENCE);
    evidence.exec("INSERT INTO documents VALUES ('new-write')");
    if (env.ROLLOUT_FAILURE === 'migrate') db.exec('CREATE TABLE new_schema(id INTEGER)');
    evidence.close();
    writeFileSync(env.ROLLOUT_LAUNCHED, '');
  }
  db.close();
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { clearInterval(keepAlive); resolve(); });
    writeFileSync(env.ROLLOUT_READY, '');
  });
});
`;
  await fs.writeFile(previous, daemon);
  await fs.writeFile(path.join(dir, "fixture-cli.mjs"), `if (process.argv[2] === 'daemon') { await import(${JSON.stringify(previous)}); } else { await import('./real-cli.js'); }\n`);
  await fs.writeFile(path.join(bin, "npm"), `#!/usr/bin/env bash
set -eu
[[ $1 == ci ]]
printf 'build\n' >> "$ROLLOUT_LOG"
[[ $ROLLOUT_FAILURE != build ]]
cp -R "$ROLLOUT_ROOT/dist" .
ln -s "$ROLLOUT_ROOT/node_modules" node_modules
mv dist/src/importer/cli.js dist/src/importer/real-cli.js
cp ${JSON.stringify(path.join(dir, "fixture-cli.mjs"))} dist/src/importer/cli.js
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, "fixture-engine"), `#!/usr/bin/env bash
set -eu
[[ ! -f $ROLLOUT_PID ]]
case " $* " in
  *' pg_dump '*) printf 'backup\n' >> "$ROLLOUT_LOG"; printf 'database archive\n' ;;
  *' pg_restore '*) read -r archive; [[ $archive == 'database archive' ]] ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -eu
[[ $1 == --user ]]
current() {
  local unit=$ROLLOUT_BASE
  [[ ! -f $ROLLOUT_DROP ]] || unit=$ROLLOUT_DROP
  grep '^ExecStart=.' "$unit" | cut -d '"' -f 4
}
case "$2" in
  show)
    case "$4" in
      LoadState) echo loaded ;;
      ActiveState) if [[ -f $ROLLOUT_PID ]]; then echo active; else echo inactive; fi ;;
      MainPID) if [[ -f $ROLLOUT_PID ]]; then cat "$ROLLOUT_PID"; else echo 0; fi ;;
      ExecStart) current ;;
      *) exit 2 ;;
    esac ;;
  daemon-reload) printf 'reload\n' >> "$ROLLOUT_LOG" ;;
  start)
    cli=$(current)
    printf 'start %s\n' "$cli" >> "$ROLLOUT_LOG"
    rm -f "$ROLLOUT_READY"
    "$PI_HINDSIGHT_NODE" "$cli" daemon --config "$PI_HINDSIGHT_CONFIG" 9>&- </dev/null > "$HOME/daemon-output" 2>&1 &
    echo $! > "$ROLLOUT_PID"
    for ((i=0;i<100;i++)); do [[ ! -f $ROLLOUT_READY ]] || exit 0; sleep 0.02; done
    exit 2 ;;
  stop)
    printf 'stop\n' >> "$ROLLOUT_LOG"
    if [[ -f $ROLLOUT_PID ]]; then
      id=$(<"$ROLLOUT_PID")
      kill "$id" 2>/dev/null || true
      for ((i=0;i<100;i++)); do [[ -z $(ps -o stat= -p "$id") || $(ps -o stat= -p "$id") == Z* ]] && break; sleep 0.02; done
      rm "$ROLLOUT_PID"
    fi ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  const oldDrop = `[Service]\nExecStart=\nExecStart="${process.execPath}" "${previous}" daemon --config "${config}"\n`;
  await fs.writeFile(legacyUnit ? base : drop, oldDrop);
  await fs.writeFile(telemetry, "[Service]\nEnvironment=FIXTURE=untouched\n");
  await ctl("start");
  const previousPid = await fs.readFile(pid, "utf8");
  await fs.writeFile(log, "");
  const run = () => exec("bash", [path.join(repo, "scripts", "deploy-importer.sh"), rev], { env, timeout: 20_000 });
  return { run, rev, runtime, evidence, backups, drop, oldDrop, telemetry, previous, previousPid, pid, log };
}

test("rollout stops the writer before coordinated backup and verifies a fresh snapshot heartbeat with settling work", linux, async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.match(result.stdout, new RegExp(`Deployed importer revision ${f.rev}`));
  assert.match(result.stdout, /effective ExecStart: pi-hindsight-importer.service/);
  const cli = path.join(f.runtime, "dist/src/importer/cli.js");
  assert.deepEqual((await fs.readFile(f.log, "utf8")).trim().split("\n"), ["build", "stop", "backup", "reload", `start ${cli}`]);
  assert.ok((await fs.readFile(f.drop, "utf8")).includes(cli));
  assert.match(await fs.readFile(f.telemetry, "utf8"), /FIXTURE=untouched/);
  assert.equal((await fs.stat(cli)).mode & 0o222, 0);
  const [backup] = await fs.readdir(f.backups);
  assert.ok(backup);
  const manifest = await fs.readFile(path.join(f.backups, backup, "manifest.json"), "utf8");
  assert.ok(manifest.includes(`"revision": "${f.rev}"`));
});

test("failed document verification rolls back only the runtime and preserves later SQLite writes", linux, async (t) => {
  const f = await fixture(t, "verify", true);
  await assert.rejects(f.run(), /did not pass document verification/);
  assert.equal(existsSync(f.drop), false);
  assert.ok((await fs.readFile(f.log, "utf8")).endsWith(`stop\nreload\nstart ${f.previous}\n`));
  const db = new DatabaseSync(f.evidence, { readOnly: true });
  try { assert.equal(db.prepare("SELECT id FROM documents").get()?.id, "new-write"); } finally { db.close(); }
});

test("failed verification after a migration restores the drop-in but leaves the importer stopped", linux, async (t) => {
  const f = await fixture(t, "migrate");
  await assert.rejects(f.run(), /Importer left stopped: SQLite schema changed/);
  assert.equal(await fs.readFile(f.drop, "utf8"), f.oldDrop);
  assert.equal(existsSync(f.pid), false);
});

test("failed build leaves the importer and its runtime unchanged", linux, async (t) => {
  const f = await fixture(t, "build");
  await assert.rejects(f.run());
  assert.equal(await fs.readFile(f.log, "utf8"), "build\n");
  assert.equal(await fs.readFile(f.pid, "utf8"), f.previousPid);
  assert.equal(await fs.readFile(f.drop, "utf8"), f.oldDrop);
  assert.equal(existsSync(f.runtime), false);
  assert.equal(existsSync(f.backups), false);
});
