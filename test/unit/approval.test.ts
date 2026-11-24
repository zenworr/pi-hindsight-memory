import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../../src/common/config.js";
import { activeProvider, assertImportApproval, estimateCostUsd, estimateInputTokens, readApproval } from "../../src/common/approval.js";

const legacyApproval = {
  approvedAt: "2026-01-01T00:00:00Z", provider: "local", model: "model-a", privacy: "local",
  maxEstimatedInputTokens: 1000, maxEstimatedCostUsd: 2, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, outputTokenMultiplier: 0.5,
};
const primary = "HINDSIGHT_API_LLM_PROVIDER=local\nHINDSIGHT_API_LLM_MODEL=model-a\n";
const alternate = 'HINDSIGHT_API_LLM_STRATEGY=\'{"mode":"failover"}\'\nHINDSIGHT_API_LLM_1_PROVIDER=hosted\nHINDSIGHT_API_LLM_1_MODEL = "model-b" # alternate\n';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-approval-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = defaultConfig(root);
  config.hindsight.environmentFile = path.join(root, "hindsight.env");
  config.approvalFile = path.join(root, "approval.json");
  const writeApproval = (fields: Record<string, unknown> = {}) => fs.writeFile(config.approvalFile, JSON.stringify({ ...legacyApproval, ...fields }));
  return { root, config, writeApproval };
}

test("approval gate rejects no-LLM and missing approvals", async (t) => {
  const { config, writeApproval } = await fixture(t);
  await fs.writeFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_PROVIDER=none\n");
  assert.deepEqual(activeProvider(config), { provider: "none", model: "unknown" });
  assert.throws(() => assertImportApproval(config), /No import approval/);
  await writeApproval();
  assert.throws(() => assertImportApproval(config), /no fact-extraction provider/);
});

test("approval gate accepts legacy approvals and explicit null caps", async (t) => {
  const { config, writeApproval } = await fixture(t);
  await fs.writeFile(config.hindsight.environmentFile, primary);
  await writeApproval();
  const approval = assertImportApproval(config);
  assert.deepEqual(approval, legacyApproval);
  assert.equal(estimateInputTokens(401), 101);
  assert.equal(estimateCostUsd(1000, approval), 0.002);
  await writeApproval({ maxEstimatedInputTokens: null, continuousMinFailureSample: 4, maxFailureRate: 1, minFreeBytes: 0, model: "*" });
  const uncapped = assertImportApproval(config);
  assert.equal(uncapped.maxEstimatedInputTokens, null);
  assert.equal(uncapped.continuousMinFailureSample, 4);
  await writeApproval({ provider: "other" });
  assert.throws(() => assertImportApproval(config), /does not match active provider/);
  await writeApproval({ model: "other" });
  assert.throws(() => assertImportApproval(config), /does not match active model/);
});

test("approval parser rejects malformed prices, failure rates, and non-integral counts", async (t) => {
  const { config, writeApproval } = await fixture(t);
  const invalidFields = {
    maxEstimatedInputTokens: [undefined, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "null", false],
    maxEstimatedCostUsd: [undefined, -1, "0", null],
    inputUsdPerMillionTokens: [-1, "1", null, {}], outputUsdPerMillionTokens: [-1, "invalid", null],
    outputTokenMultiplier: [-1, "0", null], minFreeBytes: [-1, 0.5, "1", null],
    maxFailureRate: [null, 0, -1, 1.1, "0.05", "invalid", true],
    continuousMinFailureSample: [null, 0, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1],
  };
  for (const [key, values] of Object.entries(invalidFields)) {
    for (const value of values) {
      await writeApproval({ [key]: value });
      assert.throws(() => readApproval(config.approvalFile), new RegExp(key));
    }
  }
  await fs.writeFile(config.approvalFile, JSON.stringify(legacyApproval).replace('"maxEstimatedCostUsd":2', '"maxEstimatedCostUsd":1e999'));
  assert.throws(() => readApproval(config.approvalFile), /maxEstimatedCostUsd/);
});

test("approval parser rejects unknown keys and malformed declarations", async (t) => {
  const { config, writeApproval } = await fixture(t);
  for (const [fields, error] of [
    [{ apiKey: "not-a-key" }, /unknown key/],
    [{ privacy: "remote" }, /privacy/],
    [{ approvedAt: 1 }, /approvedAt/],
    [{ approvedAt: "2026-02-30" }, /approvedAt/],
    [{ provider: "" }, /provider/],
    [{ model: false }, /model/],
    [{ alternateRoutes: { provider: "hosted", model: "model-b" } }, /alternateRoutes/],
    [{ alternateRoutes: [{ provider: "hosted", model: "model-b", apiKey: "not-a-key" }] }, /alternateRoutes/],
    [{ alternateRoutes: [{ provider: "hosted", model: "*" }] }, /alternateRoutes/],
  ] as const) {
    await writeApproval(fields);
    assert.throws(() => readApproval(config.approvalFile), error);
  }
});

test("approval gate requires an exact approval for every declared alternate route", async (t) => {
  const { config, writeApproval } = await fixture(t);
  await fs.writeFile(config.hindsight.environmentFile, primary + alternate);
  await writeApproval({ model: "*" });
  assert.throws(() => assertImportApproval(config), /does not match active alternate route 1/);
  await writeApproval({ alternateRoutes: [{ provider: "other", model: "model-b" }] });
  assert.throws(() => assertImportApproval(config), /does not match active alternate route 1/);
  const alternateRoutes = [{ provider: "hosted", model: "model-b" }];
  await writeApproval({ privacy: "remote-redacted", alternateRoutes });
  assert.deepEqual(assertImportApproval(config).alternateRoutes, alternateRoutes);

  await fs.appendFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_2_MODEL=model-c\n");
  await writeApproval({ privacy: "remote-redacted", alternateRoutes: [...alternateRoutes, { provider: "hosted", model: "model-c" }] });
  assert.throws(() => assertImportApproval(config), /alternate route 2; both provider and model must be declared/);
  await fs.appendFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_2_PROVIDER=hosted\n");
  assert.equal(assertImportApproval(config).alternateRoutes?.length, 2);
});

test("approval helper preserves the previous file on error and replaces it privately on success", { skip: spawnSync("bash", ["-c", "command -v jq"], { stdio: "ignore" }).status !== 0 && "jq is not installed" }, async (t) => {
  const { root, writeApproval, config } = await fixture(t);
  const directory = path.join(root, "pi-hindsight-memory");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "hindsight.env"), primary);
  await writeApproval();
  const output = path.join(directory, "import-approval.json");
  await fs.link(config.approvalFile, output);
  const original = await fs.readFile(output, "utf8");
  const run = (tokens: string) => spawnSync("bash", ["scripts/create-import-approval.sh", tokens, "0", "local"], { env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root }, encoding: "utf8" });
  for (const bad of ["invalid", "0.5"]) {
    assert.notEqual(run(bad).status, 0);
    assert.equal(await fs.readFile(output, "utf8"), original);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["hindsight.env", "import-approval.json"]);
  }
  const result = run("null");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.equal(readApproval(output)?.maxEstimatedInputTokens, null);
  assert.equal(await fs.readFile(config.approvalFile, "utf8"), original);
});
