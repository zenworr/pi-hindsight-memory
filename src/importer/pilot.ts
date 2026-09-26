import fs from "node:fs/promises";
import type { InventoryReport, InventorySessionResult, Source } from "../common/types.js";

const DEFAULT_PILOT_SIZE = 200;
const EXTREME_SAMPLES_PER_SOURCE = 2;
const DECILE_COUNT = 10;

export interface PilotEntry { source: Source; nativeSessionId: string; locator: string; canonicalBytes: number; canonicalTurns: number; }

export function selectPilot(report: InventoryReport, count = DEFAULT_PILOT_SIZE, options: { maxCanonicalBytes?: number; includeLargest?: boolean } = {}): PilotEntry[] {
  const allCandidates = (report.results ?? []).filter((result) => result.status === "eligible" && result.canonicalBytes !== undefined) as Array<InventorySessionResult & { canonicalBytes: number; canonicalTurns: number }>;
  const candidates = options.maxCanonicalBytes === undefined ? allCandidates : allCandidates.filter((result) => result.canonicalBytes <= options.maxCanonicalBytes!);
  const selected: PilotEntry[] = [];
  const seen = new Set<string>();
  const add = (result: typeof candidates[number] | undefined) => {
    if (!result || seen.has(`${result.source}:${result.nativeSessionId}`) || selected.length >= count) return;
    seen.add(`${result.source}:${result.nativeSessionId}`);
    selected.push({ source: result.source, nativeSessionId: result.nativeSessionId, locator: result.locator, canonicalBytes: result.canonicalBytes, canonicalTurns: result.canonicalTurns });
  };
  const sourceOrder: Source[] = ["pi", "codex", "claude", "opencode"];
  const groups = new Map<Source, typeof candidates>();
  for (const source of sourceOrder) groups.set(source, candidates.filter((result) => result.source === source).sort((a, b) => a.canonicalBytes - b.canonicalBytes || a.nativeSessionId.localeCompare(b.nativeSessionId)));
  const available = sourceOrder.filter((source) => (groups.get(source)?.length ?? 0) > 0);
  for (const source of available) add(groups.get(source)?.[0]);
  if (options.includeLargest && count >= available.length * EXTREME_SAMPLES_PER_SOURCE) for (const source of available) { const group = groups.get(source)!; add(group[group.length - 1]); }
  for (let decile = 0; selected.length < count && decile < DECILE_COUNT; decile += 1) {
    for (const source of available) {
      const group = groups.get(source)!;
      const denominator = options.includeLargest ? DECILE_COUNT - 1 : DECILE_COUNT;
      add(group[Math.floor((group.length - 1) * decile / denominator)]);
      if (selected.length >= count) break;
    }
  }
  // Fill in round-robin order. This prevents a large source from consuming the remainder.
  const pointers = new Map<Source, number>(available.map((source) => [source, 0]));
  while (selected.length < count) {
    let added = false;
    for (const source of available) {
      const group = groups.get(source)!;
      let pointer = pointers.get(source) ?? 0;
      while (pointer < group.length && seen.has(`${group[pointer]!.source}:${group[pointer]!.nativeSessionId}`)) pointer += 1;
      pointers.set(source, pointer + 1);
      if (pointer < group.length) { add(group[pointer]); added = true; }
      if (selected.length >= count) break;
    }
    if (!added) break;
  }
  return selected;
}

export async function readInventory(pathname: string): Promise<InventoryReport> { return JSON.parse(await fs.readFile(pathname, "utf8")) as InventoryReport; }
