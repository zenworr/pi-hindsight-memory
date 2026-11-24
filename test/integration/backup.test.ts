import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { StateDatabase } from "../../src/importer/state-db.js";
import { withWriterLock } from "../../src/importer/lock.js";

const exec = promisify(execFile);
const document = "agent-session:pi:known";
const hash = "a".repeat(64);

async function fixture(t: TestContext, options: { reviewedFacts?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-backup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "custom source's folder");
  const stateDatabase = path.join(source, "importer.db");
  const evidenceDatabase = path.join(source, "search.db");
  const reviewedFactsFile = path.join(source, "reviewed.json");
  const bin = path.join(dir, "bin");
  const backups = path.join(dir, "backups");
  await fs.mkdir(bin);
  await fs.mkdir(source);
  const state = new StateDatabase(stateDatabase);
  state.db.prepare(`INSERT INTO sessions (source,native_session_id,document_id,source_locator,source_size,source_mtime,source_fingerprint,status,last_seen_at,acknowledged_hash)
    VALUES ('pi','known',?,'fixture',1,1,'fixture','ambiguous_preserved','2026-01-01',?)`).run(document, hash);
  state.close();
  const evidence = new DatabaseSync(evidenceDatabase);
  evidence.exec("CREATE TABLE documents(id TEXT PRIMARY KEY); INSERT INTO documents VALUES ('fixture');");
  evidence.close();
  if (options.reviewedFacts) await fs.writeFile(reviewedFactsFile, "[]\n");
  const remote = { hash, pending: 0, processing: 0, busyOnSecondCheck: false, reply: { results: [{ document_id: document }] } as object };
  let statsChecks = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const suffix = url.pathname.replace(/^\/v1\/default\/banks\/backup-fixture\//, "");
    switch (suffix) {
      case "/health": res.end("{}"); break;
      case "stats": {
        statsChecks++;
        const pending = remote.busyOnSecondCheck && statsChecks === 2 ? 1 : remote.pending;
        res.end(JSON.stringify({ total_documents: 1, pending_operations: pending, operations_by_status: { processing: remote.processing } }));
        break;
      }
      case "operations": res.end(JSON.stringify({ operations: [] })); break;
      case "documents": res.end(JSON.stringify({ total: 1, items: [{ id: document, content_hash: remote.hash }] })); break;
      case "memories/recall": res.end(JSON.stringify(remote.reply)); break;
      default: res.writeHead(404).end("{}");
    }
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.close(); });
  const binding = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const configPath = path.join(dir, "custom-config.json");
  const apiTokenFile = path.join(dir, "token");
  await fs.writeFile(apiTokenFile, "fixture-token\n", { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify({ stateDatabase, evidenceDatabase, reviewedFactsFile, hindsight: { apiTokenFile, bankId: "backup-fixture", apiUrl: `http://${binding}`, httpMaxAttempts: 1 } }));
  await fs.writeFile(path.join(bin, "engine"), `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *' pg_dump '*)
    printf 'postgres archive fixture\\n'
    if [[ \${BACKUP_FAILURE:-} == dump ]]; then exit 1; fi
    if [[ \${BACKUP_FAILURE:-} == publish ]]; then
      for stage in "$PI_HINDSIGHT_BACKUP_DIR"/.partial-*; do
        base=\${stage##*/.partial-}
        mkdir "$PI_HINDSIGHT_BACKUP_DIR/backup-$base"
        touch "$PI_HINDSIGHT_BACKUP_DIR/backup-$base/keep"
      done
    fi ;;
  *' pg_restore -f /dev/null '*) read -r dump; [[ $dump == 'postgres archive fixture' ]] ;;
  *' pg_restore '*) read -r dump; [[ $dump == 'postgres archive fixture' ]] ;;
  *' pg_isready '*|' network '*|' volume '*|' run '*|' rm '*) ;;
  ' port '*) printf '%s\\n' "$BACKUP_TEST_BINDING" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, "ssh"), '#!/usr/bin/env bash\n[[ $1 == -o && $2 == BatchMode=yes && $3 == fixture-host ]] || exit 2\nread -ra args <<< "$4"\n[[ ${args[0]} == docker ]] || exit 2\nexec engine "${args[@]:1}"\n', { mode: 0o700 });
  const env = {
    HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    PI_HINDSIGHT_CONFIG: configPath, PI_HINDSIGHT_BACKUP_DIR: backups, PI_HINDSIGHT_CONTAINER_ENGINE: "engine",
    BACKUP_TEST_BINDING: binding, POSTGRES_IMAGE: "fixture-db", HINDSIGHT_IMAGE: "fixture-app",
  };
  const run = (script: string, args: string[], overrides: Record<string, string> = {}) => exec("bash", [path.resolve("scripts", script), ...args], { env: { ...env, ...overrides }, timeout: 15_000 });
  const capture = async () => {
    await run("backup.sh", ["--coordinated"]);
    const [published] = await fs.readdir(backups);
    assert.ok(published);
    assert.match(published, /^backup-/);
    return path.join(backups, published, "manifest.json");
  };
  const restore = (manifest: string, args: string[] = []) => run("restore-test.sh", [...args, manifest, "known example query", document]);
  return { backups, stateDatabase, evidenceDatabase, reviewedFactsFile, configPath, remote, run, capture, restore };
}

test("coordinated backup resolves custom paths and restores exact hashes and linked query evidence", async (t) => {
  const f = await fixture(t, { reviewedFacts: true });
  const manifest = await f.capture();
  const data = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal(data.consistency, "coordinated");
  assert.match(data.revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(data.sourcePaths, { config: f.configPath, state: f.stateDatabase, evidence: f.evidenceDatabase, reviewedFacts: f.reviewedFactsFile });
  assert.deepEqual(data.counts, { acknowledgedDocuments: 1, evidenceDocuments: 1, hindsightDocuments: 1 });
  assert.equal(await fs.readFile(path.join(path.dirname(manifest), "current-facts.json"), "utf8"), "[]\n");
  assert.equal((await fs.stat(manifest)).mode & 0o777, 0o600);
  f.remote.reply = { results: [{ source_fact_ids: ["fact"] }], source_facts: { fact: { document_id: document } } };
  assert.match((await f.restore(manifest)).stdout, /verified 1 document hashes/);
  assert.deepEqual((await fs.readdir(path.dirname(manifest))).sort(), ["current-facts.json", "evidence.sqlite3", "hindsight.dump", "manifest.json", "state.sqlite3"]);
});

test("restore rejects equal document counts with different hashes", async (t) => {
  const f = await fixture(t);
  const manifest = await f.capture();
  f.remote.hash = "b".repeat(64);
  await assert.rejects(f.restore(manifest), /0 missing, 0 unexpected, 1 hash mismatches/);
});

test("restore rejects a successful query response without the expected linked source", async (t) => {
  const f = await fixture(t);
  const manifest = await f.capture();
  f.remote.reply = { results: [{ document_id: "wrong" }], source_facts: { orphan: { document_id: document } } };
  await assert.rejects(f.restore(manifest), /did not return the expected document/);
});

test("restore rejects missing evidence and capture refuses to publish without evidence", async (t) => {
  const f = await fixture(t);
  const manifest = await f.capture();
  await fs.rm(path.join(path.dirname(manifest), "evidence.sqlite3"));
  await assert.rejects(f.restore(manifest), /evidence.sqlite3/);
  await fs.rm(f.evidenceDatabase);
  await assert.rejects(f.run("backup.sh", ["--coordinated"]), /search.db/);
  assert.deepEqual(await fs.readdir(f.backups), [path.basename(path.dirname(manifest))]);
});

test("failed capture removes partial files and failed publication exposes no manifest", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("backup.sh", ["--coordinated"], { BACKUP_FAILURE: "dump" }), /PostgreSQL snapshot failed/);
  assert.deepEqual(await fs.readdir(f.backups), []);
  await assert.rejects(f.run("backup.sh", ["--coordinated"], { BACKUP_FAILURE: "publish" }), /rename/);
  const [existing, ...others] = await fs.readdir(f.backups);
  assert.ok(existing);
  assert.match(existing, /^backup-/);
  assert.deepEqual(others, []);
  assert.deepEqual(await fs.readdir(path.join(f.backups, existing)), ["keep"]);
});

test("coordinated capture refuses a held writer lock, unresolved submissions and remote work", async (t) => {
  const f = await fixture(t);
  await withWriterLock(f.stateDatabase, async () => {
    await assert.rejects(f.run("backup.sh", ["--coordinated"]), /writer lock is busy/);
  });
  for (const status of ["pending", "processing"] as const) {
    f.remote[status] = 1;
    await assert.rejects(f.run("backup.sh", ["--coordinated"]), /active operations/);
    f.remote[status] = 0;
  }
  const db = new DatabaseSync(f.stateDatabase);
  db.prepare("INSERT INTO operations (operation_id,document_id,canonical_hash,hindsight_status,retry_count) VALUES ('fixture',?,?,'submitting',0)").run(document, hash);
  db.close();
  await assert.rejects(f.run("backup.sh", ["--coordinated"]), /unresolved submissions/);
  assert.deepEqual(await fs.readdir(f.backups), []);
});

test("coordinated capture refuses to publish if remote work starts during capture", async (t) => {
  const f = await fixture(t);
  f.remote.busyOnSecondCheck = true;
  await assert.rejects(f.run("backup.sh", ["--coordinated"]), /active operations/);
  assert.deepEqual(await fs.readdir(f.backups), []);
});

test("SSH mirror backup is uncoordinated and strict restore rejects it and legacy backups", async (t) => {
  const f = await fixture(t);
  const result = await f.run("backup.sh", [], { PI_HINDSIGHT_SSH_HOST: "fixture-host" });
  assert.match(result.stderr, /Uncoordinated backup/);
  const [published] = await fs.readdir(f.backups);
  assert.ok(published);
  const manifest = path.join(f.backups, published, "manifest.json");
  const data = JSON.parse(await fs.readFile(manifest, "utf8"));
  assert.equal(data.consistency, "uncoordinated");
  assert.equal(data.counts.hindsightDocuments, null);
  await assert.rejects(f.restore(manifest), /Strict restore verification rejects uncoordinated backups/);
  await assert.rejects(f.restore(path.join(f.backups, "hindsight-legacy.dump")), /Legacy backups are uncoordinated/);
  assert.match((await f.restore(manifest, ["--allow-uncoordinated"])).stdout, /verified 1 document hashes/);
});
