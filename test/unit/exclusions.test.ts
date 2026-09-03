import test from "node:test";
import assert from "node:assert/strict";
import { configuredExclusion, excludedLabel, normalizeSessionLabel } from "../../src/importer/exclusions.js";

test("session exclusions use normalized exact labels only", () => {
  const config = { exactLabels: ["excluded-session"] };
  assert.equal(normalizeSessionLabel("  EXCLUDED－SESSION  "), "excluded-session");
  assert.equal(excludedLabel(" EXCLUDED-SESSION ", config), "excluded-session");
  assert.equal(excludedLabel("excluded-session-worker", config), undefined);
  assert.deepEqual(configuredExclusion("excluded-session", config), { kind: "configured-exclusion", reason: "configured-exact-session-label:excluded-session", policyVersion: "2", label: "excluded-session" });
});
