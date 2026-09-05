import type { AppConfig, Source } from "../common/types.js";
import { scan } from "./scanner.js";
import { StateDatabase } from "./state-db.js";
import type { PilotEntry } from "./pilot.js";

export interface QueuePilotSummary { selected: number; queued: number; alreadyKnown: number; errors: Array<{ source: Source; nativeSessionId: string; error: string }>; }

export async function queuePilot(config: AppConfig, state: StateDatabase, entries: PilotEntry[]): Promise<QueuePilotSummary> {
  const summary: QueuePilotSummary = { selected: entries.length, queued: 0, alreadyKnown: 0, errors: [] };
  for (const source of new Set(entries.map((entry) => entry.source))) {
    const ids = entries.filter((entry) => entry.source === source).map((entry) => entry.nativeSessionId);
    const result = await scan(config, state, { source, sessionIds: ids, force: true });
    summary.queued += result.queued;
    for (const id of ids) {
      const session = result.results.find((item) => item.nativeSessionId === id);
      if (!session || !["eligible", "empty_after_normalization"].includes(session.status)) summary.errors.push({ source, nativeSessionId: id, error: session?.error ?? session?.status ?? "session was not found" });
    }
    summary.alreadyKnown += Math.max(0, result.results.filter((item) => item.status === "eligible").length - result.queued);
  }
  return summary;
}
