import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../common/types.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { DEFAULT_DESKTOP_FEED_MAX_AGE_SECONDS, MS_PER_SECOND } from "../common/limits.js";

const HEARTBEAT_STALE_MS = 45_000;
const MIN_SCAN_STALE_MS = 600_000;
const SCAN_GRACE_MULTIPLIER = 2;

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
  desktopFeedAgeSeconds?: number;
  desktopFeedStale?: boolean;
  uncertain: number;
}

export function importerHealth(config: AppConfig, database?: DatabaseSync): ImporterHealth {
  const db = database ?? new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
  try {
    const count = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { count: number }).count);
    const heartbeat = db.prepare("SELECT pid,heartbeat_at,phase,last_error FROM daemon_status WHERE id=1").get() as { pid: number; heartbeat_at: string; phase: string; last_error?: string } | undefined;
    let running = Boolean(heartbeat && heartbeat.phase !== "stopped" && Date.now() - Date.parse(heartbeat.heartbeat_at) < HEARTBEAT_STALE_MS);
    if (running) { try { process.kill(heartbeat!.pid, 0); } catch { running = false; } }
    let desktopFeedAgeSeconds: number | undefined;
    if (config.desktopFeed.enabled) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(config.desktopFeed.directory, "manifest.json"), "utf8")) as { completedAt?: string };
        const completed = Date.parse(manifest.completedAt ?? "");
        if (Number.isFinite(completed) && completed <= Date.now()) desktopFeedAgeSeconds = Math.floor((Date.now() - completed) / MS_PER_SECOND);
      } catch { /* An unavailable feed is reported as stale. */ }
    }
    const desktopFeedStale = config.desktopFeed.enabled && (desktopFeedAgeSeconds === undefined || desktopFeedAgeSeconds > (config.desktopFeed.maxAgeSeconds ?? DEFAULT_DESKTOP_FEED_MAX_AGE_SECONDS));
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
      staleSources: count("SELECT count(*) AS count FROM sources WHERE enabled=1 AND (last_scan_completed_at IS NULL OR last_scan_completed_at<?)", new Date(Date.now() - Math.max(MIN_SCAN_STALE_MS, config.scanIntervalSeconds * MS_PER_SECOND * SCAN_GRACE_MULTIPLIER)).toISOString()),
      ...(config.desktopFeed.enabled ? { desktopFeedAgeSeconds, desktopFeedStale } : {}),
      uncertain: count("SELECT count(*) AS count FROM generations WHERE state IN ('submitted','processing') AND error IS NOT NULL"),
    };
  } finally { if (!database) db.close(); }
}
