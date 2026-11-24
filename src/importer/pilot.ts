import fs from "node:fs/promises";
import { SOURCES, type InventoryReport, type Source } from "../common/types.js";
import type { ReviewedSession } from "./scanner.js";

const DEFAULT_PILOT_SIZE = 200;
const EXTREME_SAMPLES_PER_SOURCE = 2;
const DECILE_COUNT = 10;

export const STALE_PILOT = "Pilot no longer matches eligible source sessions; regenerate the inventory and pilot";
export interface PilotEntry extends ReviewedSession { source: Source; nativeSessionId: string; canonicalTurns: number; }

function isPilotEntry(value: unknown): value is PilotEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PilotEntry>;
  return SOURCES.some((source) => source === entry.source) && typeof entry.nativeSessionId === "string" && entry.nativeSessionId.length > 0
    && typeof entry.origin === "string" && entry.origin.length > 0 && typeof entry.locator === "string" && entry.locator.length > 0
    && typeof entry.canonicalHash === "string" && /^[a-f0-9]{64}$/.test(entry.canonicalHash)
    && Number.isSafeInteger(entry.canonicalBytes) && (entry.canonicalBytes ?? 0) > 0 && Number.isSafeInteger(entry.canonicalTurns) && (entry.canonicalTurns ?? 0) > 0;
}

export function pilotGroups(entries: PilotEntry[]): Map<Source, Map<string, PilotEntry>> {
  const groups = new Map<Source, Map<string, PilotEntry>>();
  if (!Array.isArray(entries) || !entries.length) throw new Error(STALE_PILOT);
  for (const entry of entries) {
    if (!isPilotEntry(entry)) throw new Error(STALE_PILOT);
    const group = groups.get(entry.source) ?? new Map<string, PilotEntry>();
    if (group.has(entry.nativeSessionId)) throw new Error(STALE_PILOT);
    group.set(entry.nativeSessionId, entry);
    groups.set(entry.source, group);
  }
  return groups;
}

export function selectPilot(report: InventoryReport, count = DEFAULT_PILOT_SIZE, options: { maxCanonicalBytes?: number; includeLargest?: boolean } = {}): PilotEntry[] {
  const allCandidates = (report.results ?? []).filter((result) => result.status === "eligible").map((result): PilotEntry => {
    if (!isPilotEntry(result)) throw new Error(STALE_PILOT);
    const { source, nativeSessionId, origin, locator, canonicalHash, canonicalBytes, canonicalTurns } = result;
    return { source, nativeSessionId, origin, locator, canonicalHash, canonicalBytes, canonicalTurns };
  });
  const candidates = options.maxCanonicalBytes === undefined ? allCandidates : allCandidates.filter((result) => result.canonicalBytes <= options.maxCanonicalBytes!);
  const selected: PilotEntry[] = [];
  const seen = new Set<string>();
  const add = (result: typeof candidates[number] | undefined) => {
    if (!result || seen.has(`${result.source}:${result.nativeSessionId}`) || selected.length >= count) return;
    seen.add(`${result.source}:${result.nativeSessionId}`);
    selected.push(result);
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
