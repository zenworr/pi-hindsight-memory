import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, Source } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import { HindsightClient } from "../hindsight/client.js";
import type { PilotEntry } from "./pilot.js";

export interface PilotRunResult { source: Source; nativeSessionId: string; canonicalBytes: number; modes: Record<string, Record<string, unknown>>; error?: string; }

export async function runPilot(config: AppConfig, entries: PilotEntry[], modes = ["concise", "verbose"], maxConcurrent = 2): Promise<PilotRunResult[]> {
  const client = new HindsightClient(config.hindsight);
  await client.ensureBank();
  const adapters = new Map(createAdapters(config).map((adapter) => [adapter.source, adapter]));
  const results: Array<PilotRunResult | undefined> = new Array(entries.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      results[index] = await runOne(config, client, adapters, entries[index]!, modes);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, Math.max(1, entries.length)) }, () => worker()));
  return results.filter((result): result is PilotRunResult => result !== undefined);
}

async function runOne(config: AppConfig, client: HindsightClient, adapters: Map<Source, ReturnType<typeof createAdapters>[number]>, entry: PilotEntry, modes: string[]): Promise<PilotRunResult> {
  const adapter = adapters.get(entry.source);
  if (!adapter) return { source: entry.source, nativeSessionId: entry.nativeSessionId, canonicalBytes: entry.canonicalBytes, modes: {}, error: "no adapter" };
  try {
    let reference;
    for await (const candidate of adapter.discover()) if (candidate.nativeSessionId === entry.nativeSessionId || candidate.locator === entry.locator) { reference = candidate; break; }
    if (!reference) throw new Error("session was not found");
    const session = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
    try {
      const content = await session.readContent();
      const modeResults: Record<string, Record<string, unknown>> = {};
      for (const mode of modes) modeResults[mode] = await client.dryRunExtract(content, { retain_extraction_mode: mode, retain_chunk_size: 30000 });
      return { source: entry.source, nativeSessionId: entry.nativeSessionId, canonicalBytes: session.canonicalBytes, modes: modeResults };
    } finally { await session.cleanup(); }
  } catch (error) { return { source: entry.source, nativeSessionId: entry.nativeSessionId, canonicalBytes: entry.canonicalBytes, modes: {}, error: error instanceof Error ? error.message : String(error) }; }
}

export async function writePilotResults(pathname: string, results: PilotRunResult[]): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(pathname)), { recursive: true, mode: 0o700 });
  await fs.writeFile(pathname, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
}
