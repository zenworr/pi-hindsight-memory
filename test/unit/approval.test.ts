import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../../src/common/config.js";
import { activeProvider, assertImportApproval, estimateCostUsd, estimateInputTokens } from "../../src/common/approval.js";

test("approval gate rejects no-LLM and missing approvals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-approval-"));
  const config = defaultConfig(root);
  config.hindsight.environmentFile = path.join(root, "hindsight.env");
  config.approvalFile = path.join(root, "approval.json");
  await fs.writeFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_PROVIDER=none\n", "utf8");
  assert.deepEqual(activeProvider(config), { provider: "none", model: "unknown" });
  assert.throws(() => assertImportApproval(config), /No import approval|no fact-extraction provider/);
  await fs.rm(root, { recursive: true, force: true });
});

test("approval gate matches the active provider and estimates a bounded cost", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-approval-"));
  const config = defaultConfig(root);
  config.hindsight.environmentFile = path.join(root, "hindsight.env");
  config.approvalFile = path.join(root, "approval.json");
  await fs.writeFile(config.hindsight.environmentFile, "HINDSIGHT_API_LLM_PROVIDER=local\nHINDSIGHT_API_LLM_MODEL=model-a\n", "utf8");
  await fs.writeFile(config.approvalFile, JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", provider: "local", model: "model-a", privacy: "local", maxEstimatedInputTokens: 1000, maxEstimatedCostUsd: 2, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, outputTokenMultiplier: 0.5 }), "utf8");
  const approval = assertImportApproval(config);
  assert.equal(approval.provider, "local");
  assert.equal(estimateInputTokens(401), 101);
  assert.equal(estimateCostUsd(1000, approval), 0.002);
  await fs.rm(root, { recursive: true, force: true });
});
