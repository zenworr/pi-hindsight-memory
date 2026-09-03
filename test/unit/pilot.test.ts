import test from "node:test";
import assert from "node:assert/strict";
import { selectPilot } from "../../src/importer/pilot.js";
import type { InventoryReport, Source } from "../../src/common/types.js";

function report(): InventoryReport {
  const sources = ["pi", "codex", "claude", "opencode"] as Source[];
  const results = sources.flatMap((source) => Array.from({ length: 30 }, (_, index) => ({ source, nativeSessionId: `${source}-${index}`, locator: `/x/${source}-${index}`, status: "eligible" as const, canonicalBytes: index + 1, canonicalTurns: index + 2 })));
  return { generatedAt: new Date().toISOString(), durationMs: 1, parserVersion: "x", canonicalSchema: "x", redactionPolicyVersion: "x", totals: {} as any, bySource: {} as any, largestCanonical: [], missingIdentifiers: 0, missingTimestamps: 0, results };
}

test("pilot selection is deterministic and covers every available source", () => {
  const first = selectPilot(report(), 20);
  const second = selectPilot(report(), 20);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.map((entry) => entry.source)), new Set(["pi", "codex", "claude", "opencode"]));
  assert.ok(first.length <= 20);
  assert.equal(first.some((entry) => entry.canonicalBytes === 30), false);
});

test("pilot selection respects a size cap and includes largest sessions only by request", () => {
  const capped = selectPilot(report(), 20, { maxCanonicalBytes: 10 });
  assert.ok(capped.length > 0);
  assert.ok(capped.every((entry) => entry.canonicalBytes <= 10));
  const withLargest = selectPilot(report(), 8, { includeLargest: true });
  for (const source of ["pi", "codex", "claude", "opencode"] as Source[]) {
    assert.ok(withLargest.some((entry) => entry.source === source && entry.canonicalBytes === 30));
  }
});
