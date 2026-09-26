import test from "node:test";
import assert from "node:assert/strict";
import { parseArguments } from "../../src/importer/arguments.js";

for (const args of [
  ["scan", "--limt", "1"], ["scan", "--limit"], ["scan", "--limit", "NaN"],
  ["scan", "--limit=0"], ["scan", "--limit=1.5"], ["scan", "--limit=-1"],
  ["daemon", "--once", "--once"], ["scan", "unexpected"], ["repair", "--max-ms=Infinity"],
  ["daemon", "--no-scan=false"], ["config", "--defaults", "--check"], ["constructor"],
  ["config", "--config"], ["import-all", "--cohort=0"], ["run-pilot", "input.json"],
  ["repair", "--max-ms=2147483648"], ["scan", "--source=unknown"],
  ["dry-run-extract", "input.jsonl", "--mode=unknown"],
]) {
  test(`CLI rejects invalid input: ${args.join(" ")}`, () => { assert.throws(() => parseArguments(args)); });
}

test("CLI handles named options around positional inputs and isolates literal arguments", () => {
  const parsed = parseArguments(["run-pilot", "--config", "custom.json", "input.json", "output.json"]);
  assert.equal(parsed.command, "run-pilot");
  assert.deepEqual(parsed.positionals, ["input.json", "output.json"]);
  assert.equal(parsed.values.config, "custom.json");
  assert.equal(parseArguments(["scan", "--limit=3"]).values.limit, "3");
  assert.equal(parseArguments(["index-evidence", "--limit=3", "--session-id=example"]).values["session-id"], "example");
  assert.equal(parseArguments(["export-canonical", "--help"]).values.help, true);
  assert.deepEqual(parseArguments(["dry-run-extract", "--", "--literal-file"]).positionals, ["--literal-file"]);
});
