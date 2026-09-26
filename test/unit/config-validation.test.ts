import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../../src/common/config.js";

const invalid: Array<[unknown, RegExp]> = [
  [{ maxInflightDocument: 3 }, /Unknown config key: maxInflightDocument/],
  [{ hindsight: { requestTimoutMs: 10 } }, /hindsight.requestTimoutMs/],
  [{ importer: { maxAttempts: "3" } }, /importer.maxAttempts must be a number/],
  [{ importer: { maxAttempts: 0 } }, /importer.maxAttempts.*positive integer/],
  [{ importer: { workBatchSize: 1.5 } }, /importer.workBatchSize.*positive integer/],
  [{ requireImportApproval: "false" }, /requireImportApproval.*boolean/],
  [{ sourceRoots: null }, /sourceRoots must be an object/],
  [{ hindsight: [] }, /hindsight must be an object/],
  [{ sourceRoots: { pi: "" } }, /sourceRoots.pi.*non-empty string/],
  [{ sessionExclusions: { exactLabels: [123] } }, /exactLabels.*non-empty strings/],
  [{ hindsight: { dryRunTimeoutMs: 0 } }, /dryRunTimeoutMs.*positive integer/],
  [{ hindsight: { requestTimeoutMs: 2_147_483_648 } }, /Node timer limit/],
  [{ hindsight: { recallMaxTokens: 1.5 } }, /recallMaxTokens.*integer/],
  [{ hindsight: { apiUrl: "http://" } }, /valid HTTP or HTTPS URL/],
  [{ hindsight: { apiUrl: "https://user:secret@example.test" } }, /without credentials/],
  [{ hindsight: { apiUrl: "https://example.test?token=secret" } }, /without credentials/],
  [{ hindsight: { bankId: "bad?bank" } }, /bankId.*letters/],
  [{ hindsight: { httpRetryDelayMs: 200, httpMaxRetryDelayMs: 100 } }, /httpMaxRetryDelayMs must be at least/],
  [{ maxInflightDocuments: Number.MAX_SAFE_INTEGER + 1 }, /positive integer/],
];

test("configuration rejects unknown keys and invalid types before resolving paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-config-"));
  const file = path.join(root, "config.json");
  try {
    for (const [value, expected] of invalid) {
      await fs.writeFile(file, JSON.stringify(value));
      assert.throws(() => loadConfig(file, root), expected);
    }
    await fs.writeFile(file, '{"CANARY_PRIVATE_VALUE":');
    assert.throws(() => loadConfig(file, root), error => error instanceof Error && /Cannot read config JSON/.test(error.message) && !error.message.includes("CANARY_PRIVATE_VALUE"));
    assert.throws(() => loadConfig(path.join(root, "missing.json"), root), /Config file not found/);
    await assert.rejects(fs.access(defaultConfig(root).stateDirectory));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("partial retry settings merge with defaults and valid zero budgets remain supported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-config-"));
  const file = path.join(root, "config.json");
  try {
    await fs.writeFile(file, JSON.stringify({ importer: { maxAttempts: 5 }, sessionSettleSeconds: 0, hindsight: { httpMaxAttempts: 2, recallMaxTokens: 0, minRelevanceScore: 0.005, operationRetentionDays: 0 } }));
    const config = loadConfig(file, root);
    assert.deepEqual(config.importer, { ...defaultConfig(root).importer, maxAttempts: 5 });
    assert.equal(config.hindsight.httpMaxAttempts, 2);
    assert.equal(config.hindsight.httpRetryDelayMs, 100);
    assert.equal(config.hindsight.recallMaxTokens, 0);
    assert.equal(config.sessionSettleSeconds, 0);
    assert.equal(config.hindsight.minRelevanceScore, 0.005);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("approval environment overrides must be explicit booleans", async () => {
  const old = process.env.PI_HINDSIGHT_REQUIRE_APPROVAL;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-config-"));
  const file = path.join(root, "config.json");
  try {
    await fs.writeFile(file, "{}");
    process.env.PI_HINDSIGHT_REQUIRE_APPROVAL = "false";
    assert.throws(() => loadConfig(file, root), /must be 0 or 1/);
    process.env.PI_HINDSIGHT_REQUIRE_APPROVAL = "0";
    assert.equal(loadConfig(file, root).requireImportApproval, false);
    process.env.PI_HINDSIGHT_REQUIRE_APPROVAL = "1";
    assert.equal(loadConfig(file, root).requireImportApproval, true);
  } finally {
    if (old === undefined) delete process.env.PI_HINDSIGHT_REQUIRE_APPROVAL; else process.env.PI_HINDSIGHT_REQUIRE_APPROVAL = old;
    await fs.rm(root, { recursive: true, force: true });
  }
});
