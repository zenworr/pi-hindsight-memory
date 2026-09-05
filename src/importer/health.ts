import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../common/types.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";

export interface ImporterHealth {
  running: boolean;
  paused: boolean;
  heartbeatAt?: string;
  phase?: string;
  lastError?: string;
  scanErrors: number;
  deferred: number;
  unprocessed: number;
  staleSources: number;
  uncertain: number;
}

export function importerHealth(config: AppConfig, database?: DatabaseSync): ImporterHealth {
  const db = database ?? new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
  try {
    const count = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { count: number }).count);
    const heartbeat = db.prepare("SELECT pid,heartbeat_at,phase,last_error FROM daemon_status WHERE id=1").get() as { pid: number; heartbeat_at: string; phase: string; last_error?: string } | undefined;
    let running = Boolean(heartbeat && heartbeat.phase !== "stopped" && Date.now() - Date.parse(heartbeat.heartbeat_at) < 45_000);
    if (running) { try { process.kill(heartbeat!.pid, 0); } catch { running = false; } }
    return {
      running,
      paused: fs.existsSync(path.join(config.stateDirectory, "paused")),
      heartbeatAt: heartbeat?.heartbeat_at,
      phase: heartbeat?.phase,
      lastError: heartbeat?.last_error ?? undefined,
      scanErrors: count("SELECT count(*) AS count FROM scan_errors"),
      deferred: count("SELECT count(*) AS count FROM scan_candidates"),
      unprocessed: count("SELECT count(*) AS count FROM sessions WHERE classification='primary' AND status NOT IN ('empty_after_normalization','source_missing') AND canonical_bytes>0 AND (acknowledged_hash IS NULL OR acknowledged_hash<>canonical_hash OR COALESCE(acknowledged_policy,'')<>?)", RETAIN_POLICY_VERSION)
        + count("SELECT count(*) AS count FROM (SELECT DISTINCT a.source,a.native_session_id FROM session_artifacts a WHERE a.classification='primary' AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.source=a.source AND s.native_session_id=a.native_session_id))"),
      staleSources: count("SELECT count(*) AS count FROM sources WHERE enabled=1 AND (last_scan_completed_at IS NULL OR last_scan_completed_at<?)", new Date(Date.now() - Math.max(600_000, config.scanIntervalSeconds * 2_000)).toISOString()),
      uncertain: count("SELECT count(*) AS count FROM generations WHERE state IN ('submitted','processing') AND error IS NOT NULL"),
    };
  } finally { if (!database) db.close(); }
}
