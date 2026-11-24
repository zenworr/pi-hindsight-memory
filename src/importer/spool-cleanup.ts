import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../common/types.js";
import { withWriterLock } from "./lock.js";
import { STALE_REDACTION_PAYLOAD } from "./pending-payload.js";
import { StateDatabase, TERMINAL_OPERATION_FAILURES, UNRESOLVED_SUBMISSION } from "./state-db.js";

interface FileTotals { files: number; bytes: number; }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export async function cleanupSpool(config: Pick<AppConfig, "stateDatabase" | "spoolDirectory">, apply: boolean): Promise<{ apply: boolean; eligible: FileTotals; kept: FileTotals; removed: FileTotals }> {
  return withWriterLock(config.stateDatabase, async () => {
    const state = new StateDatabase(config.stateDatabase, { readOnly: true });
    try {
      const result = { apply, eligible: { files: 0, bytes: 0 }, kept: { files: 0, bytes: 0 }, removed: { files: 0, bytes: 0 } };
      const root = path.join(config.spoolDirectory, "pending");
      const directory = await fs.lstat(root).catch((error: unknown) => { if (!missing(error)) throw error; });
      if (!directory) return result;
      if (!directory.isDirectory()) throw new Error("Pending spool is not a directory");

      const terminal = ["completed", ...TERMINAL_OPERATION_FAILURES];
      const eligible = state.db.prepare(`SELECT 1 FROM generations g
        JOIN operations o USING (operation_id)
        JOIN sessions s USING (source, native_session_id)
        WHERE g.operation_id=? AND o.canonical_hash=g.canonical_hash AND o.document_id=s.document_id
          AND g.state IN ('superseded','excluded','completed') AND g.repair=0
          AND COALESCE(g.error,'')<>? AND COALESCE(g.error,'') NOT LIKE ?
          AND o.hindsight_status IN (${terminal.map(() => "?").join(",")})
          AND NOT EXISTS (SELECT 1 FROM cleanup_jobs j WHERE j.phase<>'state_finalized'
            AND g.operation_id IN (j.old_operation_id, j.new_operation_id))`);
      for (const name of await fs.readdir(root)) {
        const id = /^([a-zA-Z0-9-]+)\.jsonl?(?:\.tmp)?$/.exec(name)?.[1];
        if (!id) continue;
        const file = path.join(root, name);
        const stat = await fs.lstat(file).catch((error: unknown) => { if (!missing(error)) throw error; });
        if (!stat?.isFile()) continue;
        // Publication can stop before state records the operation ID, so even a lone temporary file needs proof.
        const canRemove = eligible.get(id, STALE_REDACTION_PAYLOAD, `${UNRESOLVED_SUBMISSION}:%`, ...terminal);
        const totals = canRemove ? result.eligible : result.kept;
        totals.files++;
        totals.bytes += stat.size;
        if (apply && canRemove) {
          await fs.unlink(file);
          result.removed.files++;
          result.removed.bytes += stat.size;
        }
      }
      return result;
    } finally { state.close(); }
  });
}
