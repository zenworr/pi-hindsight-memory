import { setTimeout } from "node:timers/promises";

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms > 0) await setTimeout(ms, undefined, { signal });
}
