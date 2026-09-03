import fs from "node:fs";
import path from "node:path";

export class DaemonLock {
  private descriptor: number | undefined;
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    try {
      this.descriptor = fs.openSync(this.lockPath, "wx", 0o600);
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
      throw new Error(`Importer daemon is already running (${this.lockPath})`);
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
