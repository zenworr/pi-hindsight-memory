import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { defaultConfig, loadConfig } from "../../dist/src/common/config.js";
import { HindsightClient } from "../../dist/src/hindsight/client.js";
import { withWriterLock } from "../../dist/src/importer/lock.js";

const manifestName = "manifest.json";
const names = { postgres: "hindsight.dump", state: "state.sqlite3", evidence: "evidence.sqlite3", reviewedFacts: "current-facts.json" };
const required = [names.postgres, names.state, names.evidence];
const sha256 = /^[a-f0-9]{64}$/;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => shutdown.abort(new Error(`Backup interrupted by ${signal}`)));

function readSQLite(file, use) {
  // Verify the snapshot itself, not any unlisted WAL sidecar beside it.
  const url = pathToFileURL(file);
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url, { readOnly: true });
  try { return use(db); }
  finally { db.close(); }
}

function integrity(db, name) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  assert.ok(rows.length === 1 && rows[0].integrity_check === "ok", `${name} SQLite integrity check failed`);
}

function documentMap(rows) {
  const result = new Map();
  for (const { id, hash } of rows) {
    assert.ok(typeof id === "string" && id && typeof hash === "string" && sha256.test(hash), "Invalid document ID or hash");
    assert.ok(!result.has(id), "Duplicate document ID");
    result.set(id, hash);
  }
  return result;
}

function stateDocuments(directory, coordinated) {
  return readSQLite(path.join(directory, names.state), (db) => {
    integrity(db, "State");
    if (coordinated) {
      const unresolved = db.prepare(`SELECT 1 FROM generations WHERE state IN ('submitted','processing','cleanup_pending')
        UNION ALL SELECT 1 FROM operations WHERE COALESCE(hindsight_status,'') NOT IN ('prepared','ready','completed','failed','cancelled','error','rejected')
        UNION ALL SELECT 1 FROM cleanup_jobs WHERE phase <> 'state_finalized' LIMIT 1`).get();
      assert.ok(!unresolved, "Importer has unresolved submissions or cleanup work");
    }
    return documentMap(db.prepare(`SELECT document_id AS id, acknowledged_hash AS hash FROM sessions
      WHERE acknowledged_hash IS NOT NULL AND status NOT GLOB 'excluded_*'`).all());
  });
}

function evidenceCount(directory) {
  return readSQLite(path.join(directory, names.evidence), (db) => {
    integrity(db, "Evidence");
    return db.prepare("SELECT count(*) AS count FROM documents").get().count;
  });
}

function assertDocuments(expected, actual) {
  const missing = [...expected.keys()].filter((id) => !actual.has(id)).length;
  const unexpected = [...actual.keys()].filter((id) => !expected.has(id)).length;
  const mismatched = [...actual].filter(([id, hash]) => expected.has(id) && expected.get(id) !== hash).length;
  assert.ok(!missing && !unexpected && !mismatched, `Document verification failed: ${missing} missing, ${unexpected} unexpected, ${mismatched} hash mismatches`);
}

async function snapshot(source, target) {
  assert.ok((await fs.stat(source)).isFile(), `Expected a SQLite database: ${source}`);
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); }
  finally { db.close(); }
}

async function fileHash(file) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && stat.size > 0, `Expected a nonempty regular file: ${path.basename(file)}`);
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}

function postgresCommand(engine, host, tool, ...args) {
  const command = [engine, "exec", ...(tool === "pg_restore" ? ["-i"] : []), "hindsight-db", tool, ...args];
  if (host) {
    // These arguments use fixed strings or values already validated by backup.sh.
    return ["ssh", "-o", "BatchMode=yes", host, command.join(" ")];
  }
  return command;
}

function run([command, ...args], stdio, description) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio, signal: shutdown.signal });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${description} failed (exit ${code})`)));
  });
}

async function remoteDocuments(client) {
  try {
    const documents = await client.listDocuments(shutdown.signal);
    return documentMap(documents.map(({ id, content_hash }) => ({ id, hash: content_hash })));
  } catch {
    throw new Error("Could not read a valid Hindsight document inventory");
  }
}

async function quietDocuments(client, expected) {
  let stats;
  let current;
  try {
    [stats, ...current] = await Promise.all([client.getBankStats(shutdown.signal), client.listOperations("pending", shutdown.signal), client.listOperations("processing", shutdown.signal)]);
  } catch {
    throw new Error("Could not verify that Hindsight operations are idle");
  }
  assert.ok(stats?.pending_operations === 0 && (stats.operations_by_status?.pending ?? 0) === 0 && (stats.operations_by_status?.processing ?? 0) === 0 && current.every((items) => !items.length), "Hindsight has active operations or did not report an idle queue");
  const actual = await remoteDocuments(client);
  if (stats.total_documents !== undefined) assert.equal(actual.size, stats.total_documents, "Hindsight document inventory is incomplete");
  assertDocuments(expected, actual);
  return actual.size;
}

async function capture(consistency, directory, revision, engine, host, user, database) {
  const config = loadConfig();
  const coordinated = consistency === "coordinated";
  const sourcePaths = { config: config.configPath, state: config.stateDatabase, evidence: config.evidenceDatabase, reviewedFacts: config.reviewedFactsFile };
  const captureSet = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const stage = await fs.mkdtemp(path.join(directory, `.partial-${stamp}-`));
    try {
      await snapshot(sourcePaths.state, path.join(stage, names.state));
      await snapshot(sourcePaths.evidence, path.join(stage, names.evidence));
      const expected = stateDocuments(stage, coordinated);
      const evidence = evidenceCount(stage);
      const files = [...required];
      try {
        await fs.copyFile(sourcePaths.reviewedFacts, path.join(stage, names.reviewedFacts));
        files.push(names.reviewedFacts);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const client = coordinated ? new HindsightClient(config.hindsight) : undefined;
      const hindsightDocuments = client ? await quietDocuments(client, expected) : null;
      const dump = path.join(stage, names.postgres);
      let fd = await fs.open(dump, "wx", 0o600);
      try {
        await run(postgresCommand(engine, host, "pg_dump", "-U", user, "-d", database, "-Fc"), ["ignore", fd.fd, "inherit"], "PostgreSQL snapshot");
      } finally { await fd.close(); }
      fd = await fs.open(dump, "r");
      try {
        await run(postgresCommand(engine, host, "pg_restore", "-f", "/dev/null"), [fd.fd, "ignore", "inherit"], "PostgreSQL archive verification");
      } finally { await fd.close(); }
      if (client) await quietDocuments(client, expected);
      for (const file of files) await fs.chmod(path.join(stage, file), 0o600);
      const checksums = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await fileHash(path.join(stage, file))])));
      const manifest = { version: 1, revision, createdAt: new Date().toISOString(), consistency, bankId: config.hindsight.bankId, sourcePaths, counts: { acknowledgedDocuments: expected.size, evidenceDocuments: evidence, hindsightDocuments }, checksums };
      await fs.writeFile(path.join(stage, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      const published = path.join(directory, path.basename(stage).replace(/^\.partial-/, "backup-"));
      shutdown.signal.throwIfAborted();
      await fs.rename(stage, published);
      process.stdout.write(`Created ${consistency} backup: ${path.join(published, manifestName)}\n`);
      if (!coordinated) console.error("Uncoordinated backup: the databases can represent different generations; strict restore verification will reject this set.");
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  };
  if (coordinated) await withWriterLock(config.stateDatabase, captureSet);
  else await captureSet();
}

async function inspect(file, strict) {
  assert.ok(path.basename(file) === manifestName, "Legacy backups are uncoordinated and lack the required manifest and evidence snapshot");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(manifest.version === 1 && /^[A-Za-z0-9_-]+$/.test(manifest.bankId) && typeof manifest.bankId === "string", "Invalid backup manifest");
  assert.ok(["coordinated", "uncoordinated"].includes(manifest.consistency), "Invalid backup consistency label");
  if (strict) assert.equal(manifest.consistency, "coordinated", "Strict restore verification rejects uncoordinated backups");
  const directory = path.dirname(file);
  for (const name of required) assert.ok(Object.hasOwn(manifest.checksums ?? {}, name), `Manifest is missing ${name}`);
  for (const [name, checksum] of Object.entries(manifest.checksums)) {
    assert.ok(Object.values(names).includes(name) && typeof checksum === "string" && sha256.test(checksum), "Invalid backup checksum entry");
    assert.equal(await fileHash(path.join(directory, name)), checksum, `Checksum mismatch: ${name}`);
  }
  const expected = stateDocuments(directory, manifest.consistency === "coordinated");
  assert.equal(expected.size, manifest.counts?.acknowledgedDocuments, "State document count differs from manifest");
  assert.equal(evidenceCount(directory), manifest.counts?.evidenceDocuments, "Evidence document count differs from manifest");
  if (manifest.consistency === "coordinated") assert.equal(expected.size, manifest.counts?.hindsightDocuments, "Hindsight document count differs from manifest");
  return { bankId: manifest.bankId, consistency: manifest.consistency, expected };
}

async function verifyRestored(file, strict, apiUrl, apiTokenFile, query, expectedDocument) {
  const { bankId, consistency, expected } = await inspect(file, strict);
  assert.ok(expected.has(expectedDocument), "Expected query document is not in the backup");
  const client = new HindsightClient({ ...defaultConfig().hindsight, apiUrl, bankId, apiTokenFile });
  assertDocuments(expected, await remoteDocuments(client));
  let recalled;
  try { recalled = await client.recall(query, shutdown.signal); }
  catch { throw new Error("Isolated Hindsight recall failed"); }
  const supported = recalled?.results?.some((result) => result.document_id === expectedDocument || result.source_fact_ids?.some((id) => recalled.source_facts?.[id]?.document_id === expectedDocument));
  assert.ok(supported, "Known query did not return the expected document or a result linked to it");
  process.stdout.write(`Isolated restore verified ${expected.size} document hashes and the expected result for the known query (${consistency} backup).\n`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "capture") await capture(...args);
  else if (command === "inspect") await inspect(args[0], args[1] === "strict");
  else if (command === "verify") await verifyRestored(args[0], args[1] === "strict", ...args.slice(2));
  else throw new Error("Invalid backup helper command");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
