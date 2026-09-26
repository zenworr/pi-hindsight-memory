import fs from "node:fs";
import path from "node:path";
import { PRIVATE_FILE_MODE } from "../common/limits.js";
import type { AppConfig } from "../common/types.js";
import { StateDatabase } from "./state-db.js";

export async function withStateLock<T>(config: AppConfig, fn: (state: StateDatabase) => T | Promise<T>): Promise<T> {
  const lock = new DaemonLock(path.join(config.stateDirectory, "daemon.lock"));
  lock.acquire();
  try {
    const state = new StateDatabase(config.stateDatabase);
    try { return await fn(state); }
    finally { state.close(); }
  } finally { lock.release(); }
}

class DaemonLock {
  private descriptor: number | undefined;
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      this.descriptor = fs.openSync(this.lockPath, "wx", PRIVATE_FILE_MODE);
      fs.writeSync(this.descriptor, `${process.pid}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(this.lockPath, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 0) stale = true;
        else {
          try { process.kill(pid, 0); }
          catch (probeError) { if ((probeError as NodeJS.ErrnoException).code === "ESRCH") stale = true; }
        }
      } catch { stale = true; }
      if (stale) {
        try { fs.rmSync(this.lockPath, { force: true }); } catch { /* another process may own it */ }
        this.acquire();
        return;
      }
      throw new Error(`Importer daemon is already running (${this.lockPath})`, { cause: error });
    }
  }

  release(): void {
    if (this.descriptor !== undefined) {
      try { fs.closeSync(this.descriptor); } catch { /* already closed */ }
      this.descriptor = undefined;
      try { fs.rmSync(this.lockPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
