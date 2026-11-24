import fs from "node:fs/promises";
import path from "node:path";
import { estimateCostUsd, estimateInputTokens } from "../common/approval.js";
import { JSON_INDENT } from "../common/limits.js";
import type { AppConfig, CanonicalSession, ImportApproval, Source } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
import { errorMessage } from "../common/logging.js";
import { HindsightClient } from "../hindsight/client.js";
import { pilotGroups, STALE_PILOT, type PilotEntry } from "./pilot.js";
import { scan } from "./scanner.js";
import { StateDatabase } from "./state-db.js";

const PILOT_CONCURRENCY = 2;
const PILOT_MODES = ["concise", "verbose"];
const PILOT_CHUNK_SIZE = 30_000;
const COST_DECIMAL_PLACES = 4;

export interface PilotRunResult { source: Source; nativeSessionId: string; canonicalBytes: number; modes: Record<string, Record<string, unknown>>; error?: string; }

export async function runPilot(config: AppConfig, entries: PilotEntry[], approval: ImportApproval): Promise<PilotRunResult[]> {
  const groups = pilotGroups(entries);
  const stateExists = await fs.access(config.stateDatabase).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
  const state = stateExists ? new StateDatabase(config.stateDatabase, { readOnly: true }) : new StateDatabase(":memory:");
  const snapshots = new Map<string, CanonicalSession>();
  try {
    try {
      for (const [source, expected] of groups) {
        await scan(config, state, { source, sessionIds: [...expected.keys()], inventoryOnly: true, review: { expected, error: STALE_PILOT, capture: (session) => { snapshots.set(session.documentId, session); } } });
      }
    } finally { state.close(); }
    const estimatedTokens = [...snapshots.values()].reduce((sum, session) => sum + estimateInputTokens(session.canonicalBytes) * PILOT_MODES.length, 0);
    const estimatedCost = estimateCostUsd(estimatedTokens, approval);
    if (approval.maxEstimatedInputTokens !== null && estimatedTokens > approval.maxEstimatedInputTokens) throw new Error(`Two-mode pilot estimate ${estimatedTokens} exceeds approved input-token limit ${approval.maxEstimatedInputTokens}`);
    if (estimatedCost > approval.maxEstimatedCostUsd) throw new Error(`Two-mode pilot estimate $${estimatedCost.toFixed(COST_DECIMAL_PLACES)} exceeds approved cost limit $${approval.maxEstimatedCostUsd}`);
    const client = new HindsightClient(config.hindsight);
    await client.ensureBank();
    const results: PilotRunResult[] = [];
    const pending = entries.entries();
    async function worker(): Promise<void> {
      for (const [index, entry] of pending) {
        const result: PilotRunResult = { source: entry.source, nativeSessionId: entry.nativeSessionId, canonicalBytes: entry.canonicalBytes, modes: {} };
        try {
          const session = snapshots.get(documentIdFor(entry.source, entry.nativeSessionId))!;
          const content = await session.readContent();
          for (const mode of PILOT_MODES) result.modes[mode] = await client.dryRunExtract(content, { retain_extraction_mode: mode, retain_chunk_size: PILOT_CHUNK_SIZE });
        } catch (error) { result.error = errorMessage(error); }
        results[index] = result;
      }
    }
    await Promise.all(Array.from({ length: Math.min(PILOT_CONCURRENCY, entries.length) }, () => worker()));
    return results;
  } finally {
    await Promise.allSettled([...snapshots.values()].map((session) => session.cleanup()));
  }
}

export async function writePilotResults(pathname: string, results: PilotRunResult[]): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(pathname)), { recursive: true, mode: 0o700 });
  await fs.writeFile(pathname, `${JSON.stringify(results, null, JSON_INDENT)}\n`, { mode: 0o600 });
}
