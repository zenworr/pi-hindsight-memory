import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Source } from "../common/types.js";

export interface DirtyMarkerInput {
  source: Source;
  sessionFile: string;
  sessionId?: string;
  reason: "session_compact" | "session_shutdown";
}

export function markerName(sessionFile: string): string {
  return `${crypto.createHash("sha256").update(sessionFile).digest("hex")}.json`;
}

/** Best-effort, synchronous and intentionally tiny. The periodic scanner is authoritative. */
export function writeDirtyMarker(directory: string, input: DirtyMarkerInput): boolean {
  try {
    const targetDirectory = path.join(directory, input.source);
    fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(targetDirectory, markerName(input.sessionFile));
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const value = {
      source: input.source,
      session_file: input.sessionFile,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      reason: input.reason,
      marked_at: new Date().toISOString(),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    return false;
  }
}

export async function writeDirtyMarkerAsync(directory: string, input: DirtyMarkerInput): Promise<boolean> {
  try {
    const targetDirectory = path.join(directory, input.source);
    await fs.promises.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(targetDirectory, markerName(input.sessionFile));
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const value = {
      source: input.source,
      session_file: input.sessionFile,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      reason: input.reason,
      marked_at: new Date().toISOString(),
    };
    await fs.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, target);
    return true;
  } catch { return false; }
}

export function clearDirtyMarker(directory: string, source: Source, sessionFile: string): void {
  try { fs.rmSync(path.join(directory, source, markerName(sessionFile)), { force: true }); } catch { /* scanner retries */ }
}
