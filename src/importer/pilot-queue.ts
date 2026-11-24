import type { AppConfig } from "../common/types.js";
import { scan } from "./scanner.js";
import type { StateDatabase } from "./state-db.js";
import { pilotGroups, STALE_PILOT, type PilotEntry } from "./pilot.js";

export async function queuePilot(config: AppConfig, state: StateDatabase, entries: PilotEntry[]): Promise<{ selected: number; queued: number; alreadyKnown: number; errors: [] }> {
  const groups = pilotGroups(entries);
  for (const [source, expected] of groups) {
    await scan(config, state, { source, sessionIds: [...expected.keys()], inventoryOnly: true, review: { expected, error: STALE_PILOT } });
  }
  let queued = 0;
  for (const [source, expected] of groups) {
    const result = await scan(config, state, { source, sessionIds: [...expected.keys()], force: true, review: { expected, error: STALE_PILOT } });
    if (result.errors) throw new Error("Pilot queue failed; inspect importer scan errors");
    queued += result.queued;
  }
  return { selected: entries.length, queued, alreadyKnown: entries.length - queued, errors: [] };
}
