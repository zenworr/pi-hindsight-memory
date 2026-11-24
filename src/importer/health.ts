import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, ImportFailureReason } from "../common/types.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { DEFAULT_DESKTOP_FEED_MAX_AGE_SECONDS, MS_PER_SECOND } from "../common/limits.js";
import { readApproval } from "../common/approval.js";
import { BLOCK_ACTIONS, importFreeBytes } from "./admission.js";
import { STALE_REDACTION_PAYLOAD } from "./pending-payload.js";
import { readImportBlock, UNRESOLVED_SUBMISSION } from "./state-db.js";
import type { ImportBlock } from "./state-db.js";

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
  unresolvedSubmissions: number;
  quarantinedPayloads: number;
  blocked?: ImportBlock;
  diskBelowMinimum?: { availableBytes: number; minimumBytes: number };
  overdueSubmissions: number;
  oldestSubmittedAt?: string;
  oldestSubmittedAgeSeconds?: number;
  earliestOverdueRetryAt?: string;
  failureReasons: { reason: ImportFailureReason; count: number }[];
  exhaustedFailures: number;
}

export async function inspectImportDisk(config: AppConfig): Promise<ImporterHealth["diskBelowMinimum"]> {
  if (!config.requireImportApproval) return undefined;
  try {
    const minimumBytes = readApproval(config.approvalFile)?.minFreeBytes;
    if (minimumBytes === undefined) return undefined;
    const availableBytes = await importFreeBytes(config, config.stateDatabase);
    if (availableBytes < minimumBytes) return { availableBytes, minimumBytes };
  } catch { /* The daemon reports an admission block if it cannot check approval or disk space. */ }
  return undefined;
}

export function importerHealth(config: AppConfig, database?: DatabaseSync, disk?: ImporterHealth["diskBelowMinimum"]): ImporterHealth {
  const db = database ?? new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
  try {
    const now = Date.now();
    const recordedBlock = readImportBlock(db);
    const reason = disk ? "disk-below-minimum" : recordedBlock?.reason;
    const blocked = reason && Object.hasOwn(BLOCK_ACTIONS, reason)
      ? { reason, since: recordedBlock?.reason === reason ? recordedBlock.since : new Date(now).toISOString(), action: BLOCK_ACTIONS[reason] }
      : undefined;
    const deadline = new Date(Math.max(0, now - config.importer.overdueSubmissionSeconds * MS_PER_SECOND)).toISOString();
    const hasRetryColumn = db.prepare("SELECT 1 FROM pragma_table_info('operations') WHERE name='next_retry_at'").get();
    const scheduledRetry = hasRetryColumn
      ? "MIN(CASE WHEN g.submitted_at < :deadline AND o.hindsight_status IS NOT :unresolved AND o.next_retry_at > :now THEN o.next_retry_at END)"
      : "NULL";
    const submissions = db.prepare(`SELECT MIN(g.submitted_at) AS oldest, ${scheduledRetry} AS earliest_retry,
      COUNT(CASE WHEN g.submitted_at < :deadline THEN 1 END) AS overdue,
      COUNT(CASE WHEN o.hindsight_status = :unresolved THEN 1 END) AS unresolved,
      COUNT(CASE WHEN g.error = :quarantined AND o.hindsight_status IS NOT :unresolved THEN 1 END) AS quarantined,
      COUNT(CASE WHEN g.error IS NOT NULL OR o.hindsight_status = :unresolved THEN 1 END) AS uncertain
      FROM generations g LEFT JOIN operations o USING (operation_id)
      WHERE g.state IN ('submitted','processing')`).get({ deadline, unresolved: UNRESOLVED_SUBMISSION, quarantined: STALE_REDACTION_PAYLOAD, ...(hasRetryColumn ? { now: new Date(now).toISOString() } : {}) }) as {
        oldest: string | null; earliest_retry: string | null; overdue: number; unresolved: number; quarantined: number; uncertain: number;
      };
    const oldestAge = submissions.oldest ? now - Date.parse(submissions.oldest) : NaN;
    const failures = db.prepare(`SELECT CASE
      WHEN o.hindsight_status = ? THEN 'unresolved-submission'
      WHEN g.error LIKE 'Local payload integrity failure:%' THEN 'payload-integrity'
      WHEN o.hindsight_status = 'rejected' THEN 'document-rejected'
      WHEN o.hindsight_status IN ('failed','cancelled','error') THEN 'operation-failed'
      WHEN g.error = 'Free disk space is below the approved minimum' OR g.error LIKE 'Free disk space is below the approved minimum:%' THEN 'disk-below-minimum'
      ELSE 'other' END AS reason, COUNT(*) AS count, COUNT(CASE WHEN g.attempt_count >= ? THEN 1 END) AS exhausted
      FROM generations g LEFT JOIN operations o USING (operation_id) WHERE g.state = 'failed'
      GROUP BY reason ORDER BY reason`).all(UNRESOLVED_SUBMISSION, config.importer.maxAttempts) as {
        reason: ImportFailureReason; count: number; exhausted: number;
      }[];
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
      uncertain: submissions.uncertain,
      unresolvedSubmissions: submissions.unresolved,
      quarantinedPayloads: submissions.quarantined,
      blocked,
      diskBelowMinimum: disk,
      overdueSubmissions: submissions.overdue,
      oldestSubmittedAt: submissions.oldest ?? undefined,
      oldestSubmittedAgeSeconds: oldestAge >= 0 ? Math.floor(oldestAge / MS_PER_SECOND) : undefined,
      earliestOverdueRetryAt: submissions.earliest_retry ?? undefined,
      failureReasons: failures.map(({ reason, count }) => ({ reason, count })),
      exhaustedFailures: failures.reduce((total, row) => total + row.exhausted, 0),
    };
  } finally { if (!database) db.close(); }
}
