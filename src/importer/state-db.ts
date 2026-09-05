import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { CLASSIFICATION_POLICY_VERSION, RETAIN_POLICY_VERSION } from "../common/types.js";
import type { GenerationState, SessionClassification, Source, SourceFingerprint } from "../common/types.js";

export interface SessionStateRecord {
  source: Source;
  nativeSessionId: string;
  documentId: string;
  sourceLocator: string;
  sourceSize: number;
  sourceMtime: number;
  sourceFingerprint: SourceFingerprint;
  canonicalHash?: string;
  acknowledgedHash?: string;
  acknowledgedPolicy?: string;
  canonicalBytes?: number;
  canonicalTurns?: number;
  canonicalSchema?: string;
  sessionStartedAt?: string;
  sessionUpdatedAt?: string;
  status: string;
  lastSeenAt: string;
  lastError?: string;
  classification?: SessionClassification;
}

export interface SessionArtifactRecord {
  source: Source;
  locator: string;
  nativeSessionId: string;
  documentId: string;
  classification: SessionClassification;
  observedAt: string;
  sessionStartedAt?: string;
  sessionUpdatedAt?: string;
}

export interface ExclusionTombstoneRecord {
  source: Source;
  nativeSessionId: string;
  documentId: string;
  locator: string;
  label: string;
  normalizedLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupJobRecord {
  jobId: string;
  action: "delete-document";
  targetKind: "subagent" | "ambiguous" | "configured-exclusion" | "primary_replay";
  source: Source;
  nativeSessionId: string;
  documentId: string;
  canonicalHash?: string;
  oldOperationId?: string;
  newOperationId?: string;
  phase: "planned" | "remote_deleted" | "state_finalized";
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationRecord {
  source: Source;
  nativeSessionId: string;
  canonicalHash: string;
  operationId: string;
  state: GenerationState;
  queuedAt: string;
  submittedAt?: string;
  completedAt?: string;
  attemptCount: number;
  error?: string;
  retainPolicyVersion?: string;
  repair?: boolean;
}

export interface OperationRecord {
  operationId: string;
  documentId: string;
  canonicalHash: string;
  hindsightStatus?: string;
  submittedAt?: string;
  lastPolledAt?: string;
  retryCount: number;
  responseSummary?: string;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export class StateDatabase {
  readonly db: DatabaseSync;
  constructor(readonly databasePath: string) {
    if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") {
      try { fs.chmodSync(databasePath, 0o600); } catch { /* database may be created by a restricted filesystem */ }
    }
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000;");
    if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
    this.restrictFileModes();
  }

  private restrictFileModes(): void {
    if (this.databasePath === ":memory:") return;
    for (const file of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      try { fs.chmodSync(file, 0o600); } catch { /* file may not exist yet */ }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        source TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_scan_started_at TEXT,
        last_scan_completed_at TEXT,
        watermark TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        source TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        source_size INTEGER NOT NULL,
        source_mtime REAL NOT NULL,
        source_fingerprint TEXT NOT NULL,
        canonical_hash TEXT,
        canonical_bytes INTEGER,
        canonical_turns INTEGER,
        canonical_schema TEXT,
        session_started_at TEXT,
        session_updated_at TEXT,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (source, native_session_id)
      );
      CREATE INDEX IF NOT EXISTS sessions_document_id_idx ON sessions(document_id);
      CREATE TABLE IF NOT EXISTS session_aliases (
        source TEXT NOT NULL,
        alias TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source, alias),
        FOREIGN KEY (source, native_session_id) REFERENCES sessions(source, native_session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS generations (
        source TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        submitted_at TEXT,
        completed_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        PRIMARY KEY (source, native_session_id, canonical_hash),
        FOREIGN KEY (source, native_session_id) REFERENCES sessions(source, native_session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS generations_state_idx ON generations(state, queued_at);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        hindsight_status TEXT,
        submitted_at TEXT,
        last_polled_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        response_summary TEXT
      );
      CREATE TABLE IF NOT EXISTS import_budget (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        reserved_input_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      INSERT INTO import_budget(id, reserved_input_tokens, estimated_cost_usd, updated_at)
        VALUES (1, 0, 0, datetime('now')) ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS budget_reservations (
        operation_id TEXT PRIMARY KEY,
        input_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        reserved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scan_candidates (
        source TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        PRIMARY KEY (source, native_session_id)
      );
    `);
    const exists = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
    if (!exists) this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
    const classificationMigration = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 2").get();
    if (!classificationMigration) {
      for (const column of [
        "ALTER TABLE sessions ADD COLUMN classification TEXT NOT NULL DEFAULT 'primary'",
        "ALTER TABLE sessions ADD COLUMN classification_reason TEXT NOT NULL DEFAULT 'legacy-unclassified'",
        `ALTER TABLE sessions ADD COLUMN classification_policy_version TEXT NOT NULL DEFAULT '${CLASSIFICATION_POLICY_VERSION}'`,
      ]) {
        try { this.db.exec(column); } catch (error) {
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        }
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_artifacts (
          source TEXT NOT NULL,
          locator TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          classification TEXT NOT NULL,
          classification_reason TEXT NOT NULL,
          classification_policy_version TEXT NOT NULL,
          parent_session_id TEXT,
          session_started_at TEXT,
          session_updated_at TEXT,
          observed_at TEXT NOT NULL,
          PRIMARY KEY (source, locator)
        );
        CREATE INDEX IF NOT EXISTS session_artifacts_native_idx ON session_artifacts(source, native_session_id);
        CREATE INDEX IF NOT EXISTS session_artifacts_classification_idx ON session_artifacts(classification, source);
        CREATE TABLE IF NOT EXISTS exclusion_tombstones (
          source TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          locator TEXT NOT NULL,
          label TEXT NOT NULL,
          normalized_label TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (source, native_session_id, document_id)
        );
        CREATE INDEX IF NOT EXISTS exclusion_tombstones_locator_idx ON exclusion_tombstones(source, locator);
        CREATE TABLE IF NOT EXISTS cleanup_jobs (
          job_id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          source TEXT NOT NULL,
          native_session_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          canonical_hash TEXT,
          target_kind TEXT NOT NULL,
          old_operation_id TEXT,
          new_operation_id TEXT,
          phase TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cleanup_jobs_phase_idx ON cleanup_jobs(phase, updated_at);
      `);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
    }
    const settleMigration = this.db.prepare("SELECT version FROM schema_migrations WHERE version = 3").get();
    if (!settleMigration) this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(new Date().toISOString());
    if (!this.db.prepare("SELECT version FROM schema_migrations WHERE version=4").get()) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE sessions ADD COLUMN acknowledged_hash TEXT;
          ALTER TABLE sessions ADD COLUMN acknowledged_policy TEXT;
          ALTER TABLE generations ADD COLUMN retain_policy_version TEXT NOT NULL DEFAULT '1';
          ALTER TABLE generations ADD COLUMN repair INTEGER NOT NULL DEFAULT 0;
          UPDATE sessions SET acknowledged_hash=(SELECT canonical_hash FROM generations g WHERE g.source=sessions.source AND g.native_session_id=sessions.native_session_id AND g.state='completed' ORDER BY g.completed_at DESC,g.queued_at DESC LIMIT 1);
          UPDATE sessions SET acknowledged_policy='1' WHERE acknowledged_hash IS NOT NULL;
          UPDATE generations SET state='submitted' WHERE state='failed' AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id=generations.operation_id AND COALESCE(o.hindsight_status,'unknown') NOT IN ('completed','failed','cancelled','error'));
          CREATE TABLE scan_errors (source TEXT NOT NULL, locator TEXT NOT NULL, error TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(source,locator));
          CREATE TABLE daemon_status (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, heartbeat_at TEXT NOT NULL, phase TEXT NOT NULL, last_error TEXT);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (4,?)").run(new Date().toISOString());
      });
    }
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
  }

  durableTransaction<T>(fn: () => T): T {
    this.db.exec("PRAGMA synchronous = FULL");
    try { return this.transaction(fn); }
    finally { this.db.exec("PRAGMA synchronous = NORMAL"); }
  }

  upsertSource(source: Source, root: string): void {
    this.db.prepare(`INSERT INTO sources(source, root, enabled) VALUES (?, ?, 1)
      ON CONFLICT(source) DO UPDATE SET root=excluded.root`).run(source, root);
  }

  markScanStarted(source: Source, at: string): void { this.db.prepare("UPDATE sources SET last_scan_started_at=? WHERE source=?").run(at, source); }
  markScanCompleted(source: Source, at: string, watermark?: string): void { this.db.prepare("UPDATE sources SET last_scan_completed_at=?, watermark=?, last_error=NULL WHERE source=?").run(at, watermark ?? null, source); }
  markScanError(source: Source, error: string): void { this.db.prepare("UPDATE sources SET last_error=? WHERE source=?").run(error.slice(0, 2000), source); }

  recordScanError(source: Source, locator: string, error: string): void {
    this.db.prepare("INSERT INTO scan_errors(source,locator,error,observed_at) VALUES (?,?,?,?) ON CONFLICT(source,locator) DO UPDATE SET error=excluded.error,observed_at=excluded.observed_at").run(source, locator, error.slice(0, 1000), new Date().toISOString());
    this.markScanError(source, error);
  }

  clearScanError(source: Source, locator: string): void {
    this.db.prepare("DELETE FROM scan_errors WHERE source=? AND locator=?").run(source, locator);
  }

  heartbeat(phase: string, error?: string): void {
    this.db.prepare("INSERT INTO daemon_status(id,pid,heartbeat_at,phase,last_error) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,heartbeat_at=excluded.heartbeat_at,phase=excluded.phase,last_error=excluded.last_error").run(process.pid, new Date().toISOString(), phase, error?.slice(0, 1000) ?? null);
  }

  acknowledgeGeneration(generation: GenerationRecord): void {
    this.db.prepare("UPDATE sessions SET acknowledged_hash=?,acknowledged_policy=?,status=CASE WHEN canonical_hash=? AND status IN ('discovered','imported') THEN 'imported' ELSE status END WHERE source=? AND native_session_id=?").run(generation.canonicalHash, generation.retainPolicyVersion ?? RETAIN_POLICY_VERSION, generation.canonicalHash, generation.source, generation.nativeSessionId);
  }

  observeScanCandidate(source: Source, nativeSessionId: string, fingerprint: string, observedAt: string, settleMs: number): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT fingerprint, first_observed_at FROM scan_candidates WHERE source=? AND native_session_id=?").get(source, nativeSessionId) as { fingerprint: string; first_observed_at: string } | undefined;
      if (!row || row.fingerprint !== fingerprint) {
        this.db.prepare(`INSERT INTO scan_candidates(source,native_session_id,fingerprint,first_observed_at) VALUES (?,?,?,?)
          ON CONFLICT(source,native_session_id) DO UPDATE SET fingerprint=excluded.fingerprint, first_observed_at=excluded.first_observed_at`).run(source, nativeSessionId, fingerprint, observedAt);
        return false;
      }
      return Date.parse(observedAt) - Date.parse(row.first_observed_at) >= settleMs;
    });
  }

  clearScanCandidate(source: Source, nativeSessionId: string): void {
    this.db.prepare("DELETE FROM scan_candidates WHERE source=? AND native_session_id=?").run(source, nativeSessionId);
  }

  getSession(source: Source, nativeSessionId: string): SessionStateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE source=? AND native_session_id=?").get(source, nativeSessionId) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : undefined;
  }

  findSessionByAlias(source: Source, alias: string): string | undefined {
    const row = this.db.prepare("SELECT native_session_id FROM session_aliases WHERE source=? AND alias=?").get(source, alias) as Record<string, unknown> | undefined;
    return nullableString(row?.native_session_id);
  }

  addAlias(source: Source, alias: string, nativeSessionId: string): void {
    this.db.prepare(`INSERT INTO session_aliases(source, alias, native_session_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source, alias) DO UPDATE SET native_session_id=excluded.native_session_id`).run(source, alias, nativeSessionId, new Date().toISOString());
  }

  upsertSession(record: SessionStateRecord): void {
    this.db.prepare(`INSERT INTO sessions(
      source,native_session_id,document_id,source_locator,source_size,source_mtime,source_fingerprint,
      canonical_hash,canonical_bytes,canonical_turns,canonical_schema,session_started_at,session_updated_at,
      status,last_seen_at,last_error,classification,classification_reason,classification_policy_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source,native_session_id) DO UPDATE SET
      document_id=excluded.document_id, source_locator=excluded.source_locator, source_size=excluded.source_size,
      source_mtime=excluded.source_mtime, source_fingerprint=excluded.source_fingerprint,
      canonical_hash=COALESCE(excluded.canonical_hash,sessions.canonical_hash),
      canonical_bytes=COALESCE(excluded.canonical_bytes,sessions.canonical_bytes),
      canonical_turns=COALESCE(excluded.canonical_turns,sessions.canonical_turns),
      canonical_schema=COALESCE(excluded.canonical_schema,sessions.canonical_schema),
      session_started_at=COALESCE(excluded.session_started_at,sessions.session_started_at),
      session_updated_at=COALESCE(excluded.session_updated_at,sessions.session_updated_at),
      status=excluded.status,last_seen_at=excluded.last_seen_at,last_error=excluded.last_error,
      classification=excluded.classification,classification_reason=excluded.classification_reason,
      classification_policy_version=excluded.classification_policy_version`).run(
      record.source, record.nativeSessionId, record.documentId, record.sourceLocator, record.sourceSize, record.sourceMtime,
      JSON.stringify(record.sourceFingerprint), record.canonicalHash ?? null, record.canonicalBytes ?? null, record.canonicalTurns ?? null,
      record.canonicalSchema ?? null, record.sessionStartedAt ?? null, record.sessionUpdatedAt ?? null, record.status, record.lastSeenAt, record.lastError ?? null,
      record.classification?.kind ?? "primary", record.classification?.reason ?? "legacy-unclassified", record.classification?.policyVersion ?? CLASSIFICATION_POLICY_VERSION,
    );
  }

  updateSessionCanonical(source: Source, nativeSessionId: string, canonicalHash: string, bytes: number, turns: number, schema: string, startedAt: string, updatedAt: string, status: string, error?: string): void {
    this.db.prepare(`UPDATE sessions SET canonical_hash=?, canonical_bytes=?, canonical_turns=?, canonical_schema=?, session_started_at=?, session_updated_at=?, status=?, last_seen_at=?, last_error=? WHERE source=? AND native_session_id=?`).run(canonicalHash, bytes, turns, schema, startedAt, updatedAt, status, new Date().toISOString(), error ?? null, source, nativeSessionId);
  }

  markSourceMissing(source: Source, nativeSessionId: string, at: string): void {
    this.db.prepare("UPDATE sessions SET status='source_missing', last_seen_at=?, last_error=? WHERE source=? AND native_session_id=? AND status NOT IN ('excluded_subagent','excluded_ambiguous','excluded_configured','ambiguous_preserved','cleanup_pending')").run(at, "Native source was not found during a scan; Hindsight document was retained", source, nativeSessionId);
  }

  markSessionSeen(source: Source, nativeSessionId: string, fingerprint: SourceFingerprint, sourceSize: number, sourceMtime: number, restoredStatus: string): void {
    this.db.prepare("UPDATE sessions SET source_size=?, source_mtime=?, source_fingerprint=?, status=CASE WHEN status='source_missing' THEN ? ELSE status END, last_seen_at=?, last_error=NULL WHERE source=? AND native_session_id=? AND status NOT IN ('excluded_subagent','excluded_ambiguous','excluded_configured','ambiguous_preserved','cleanup_pending')").run(sourceSize, sourceMtime, JSON.stringify(fingerprint), restoredStatus, new Date().toISOString(), source, nativeSessionId);
  }

  setSessionStatus(source: Source, nativeSessionId: string, status: string): void {
    this.db.prepare("UPDATE sessions SET status=?, last_seen_at=?, last_error=NULL WHERE source=? AND native_session_id=?").run(status, new Date().toISOString(), source, nativeSessionId);
  }

  setSessionClassification(source: Source, nativeSessionId: string, classification: SessionClassification, status?: string): void {
    this.db.prepare("UPDATE sessions SET classification=?, classification_reason=?, classification_policy_version=?, status=COALESCE(?, status), last_seen_at=?, last_error=NULL WHERE source=? AND native_session_id=?").run(classification.kind, classification.reason, classification.policyVersion, status ?? null, new Date().toISOString(), source, nativeSessionId);
  }

  recordArtifact(record: SessionArtifactRecord): void {
    this.db.prepare(`INSERT INTO session_artifacts(
      source,locator,native_session_id,document_id,classification,classification_reason,
      classification_policy_version,parent_session_id,session_started_at,session_updated_at,observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source,locator) DO UPDATE SET
      native_session_id=excluded.native_session_id,document_id=excluded.document_id,
      classification=excluded.classification,classification_reason=excluded.classification_reason,
      classification_policy_version=excluded.classification_policy_version,parent_session_id=excluded.parent_session_id,
      session_started_at=excluded.session_started_at,session_updated_at=excluded.session_updated_at,
      observed_at=excluded.observed_at`).run(
      record.source, record.locator, record.nativeSessionId, record.documentId, record.classification.kind,
      record.classification.reason, record.classification.policyVersion, record.classification.parentSessionId ?? null,
      record.sessionStartedAt ?? null, record.sessionUpdatedAt ?? null, record.observedAt,
    );
  }

  recordExclusionTombstone(record: ExclusionTombstoneRecord): void {
    this.db.prepare(`INSERT INTO exclusion_tombstones(source,native_session_id,document_id,locator,label,normalized_label,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source,native_session_id,document_id) DO UPDATE SET locator=excluded.locator,label=excluded.label,normalized_label=excluded.normalized_label,updated_at=excluded.updated_at`).run(
      record.source, record.nativeSessionId, record.documentId, record.locator, record.label, record.normalizedLabel, record.createdAt, record.updatedAt,
    );
  }

  getExclusionTombstone(source: Source, nativeSessionId: string, documentId: string): ExclusionTombstoneRecord | undefined {
    const row = this.db.prepare("SELECT * FROM exclusion_tombstones WHERE source=? AND native_session_id=? AND document_id=?").get(source, nativeSessionId, documentId) as Record<string, unknown> | undefined;
    return row ? { source: String(row.source) as Source, nativeSessionId: String(row.native_session_id), documentId: String(row.document_id), locator: String(row.locator), label: String(row.label), normalizedLabel: String(row.normalized_label), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : undefined;
  }

  listExclusionTombstones(): ExclusionTombstoneRecord[] {
    return (this.db.prepare("SELECT * FROM exclusion_tombstones ORDER BY source,native_session_id").all() as Record<string, unknown>[]).map((row) => ({ source: String(row.source) as Source, nativeSessionId: String(row.native_session_id), documentId: String(row.document_id), locator: String(row.locator), label: String(row.label), normalizedLabel: String(row.normalized_label), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  listArtifacts(classification?: SessionClassification["kind"]): SessionArtifactRecord[] {
    const rows = (classification
      ? this.db.prepare("SELECT * FROM session_artifacts WHERE classification=? ORDER BY source,locator").all(classification)
      : this.db.prepare("SELECT * FROM session_artifacts ORDER BY source,locator").all()) as Record<string, unknown>[];
    return rows.map((row) => ({
      source: String(row.source) as Source,
      locator: String(row.locator),
      nativeSessionId: String(row.native_session_id),
      documentId: String(row.document_id),
      classification: {
        kind: String(row.classification) as SessionClassification["kind"],
        reason: String(row.classification_reason),
        policyVersion: String(row.classification_policy_version),
        ...(nullableString(row.parent_session_id) ? { parentSessionId: String(row.parent_session_id) } : {}),
      },
      observedAt: String(row.observed_at),
      ...(nullableString(row.session_started_at) ? { sessionStartedAt: String(row.session_started_at) } : {}),
      ...(nullableString(row.session_updated_at) ? { sessionUpdatedAt: String(row.session_updated_at) } : {}),
    }));
  }

  pendingWorkCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM generations WHERE state IN ('queued','submitted','processing') OR state='failed' AND attempt_count < 3").get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  reserveBudget(operationId: string, inputTokens: number, estimatedCostUsd: number, maxInputTokens: number, maxCostUsd: number): boolean {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT operation_id FROM budget_reservations WHERE operation_id=?").get(operationId);
      if (existing) return true;
      const row = this.db.prepare("SELECT reserved_input_tokens, estimated_cost_usd FROM import_budget WHERE id=1").get() as Record<string, unknown>;
      const tokens = Number(row.reserved_input_tokens ?? 0);
      const cost = Number(row.estimated_cost_usd ?? 0);
      if (tokens + inputTokens > maxInputTokens || cost + estimatedCostUsd > maxCostUsd) return false;
      this.db.prepare("UPDATE import_budget SET reserved_input_tokens=?, estimated_cost_usd=?, updated_at=? WHERE id=1").run(tokens + inputTokens, cost + estimatedCostUsd, new Date().toISOString());
      this.db.prepare("INSERT INTO budget_reservations(operation_id,input_tokens,estimated_cost_usd,reserved_at) VALUES (?, ?, ?, ?)").run(operationId, inputTokens, estimatedCostUsd, new Date().toISOString());
      return true;
    });
  }

  budget(): { reservedInputTokens: number; estimatedCostUsd: number } {
    const row = this.db.prepare("SELECT reserved_input_tokens, estimated_cost_usd FROM import_budget WHERE id=1").get() as Record<string, unknown>;
    return { reservedInputTokens: Number(row.reserved_input_tokens ?? 0), estimatedCostUsd: Number(row.estimated_cost_usd ?? 0) };
  }

  listSessions(source?: Source): SessionStateRecord[] {
    const rows = (source ? this.db.prepare("SELECT * FROM sessions WHERE source=? ORDER BY source,native_session_id").all(source) : this.db.prepare("SELECT * FROM sessions ORDER BY source,native_session_id").all()) as Record<string, unknown>[];
    return rows.map((row) => this.toSession(row));
  }

  private toSession(row: Record<string, unknown>): SessionStateRecord {
    let fingerprint: SourceFingerprint;
    try { fingerprint = JSON.parse(String(row.source_fingerprint)) as SourceFingerprint; } catch { fingerprint = { size: Number(row.source_size), mtimeMs: Number(row.source_mtime), sampleHash: "", stableLocator: String(row.source_locator) }; }
    return {
      source: String(row.source) as Source,
      nativeSessionId: String(row.native_session_id),
      documentId: String(row.document_id),
      sourceLocator: String(row.source_locator),
      sourceSize: Number(row.source_size),
      sourceMtime: Number(row.source_mtime),
      sourceFingerprint: fingerprint,
      canonicalHash: nullableString(row.canonical_hash),
      acknowledgedHash: nullableString(row.acknowledged_hash),
      acknowledgedPolicy: nullableString(row.acknowledged_policy),
      canonicalBytes: row.canonical_bytes == null ? undefined : Number(row.canonical_bytes),
      canonicalTurns: row.canonical_turns == null ? undefined : Number(row.canonical_turns),
      canonicalSchema: nullableString(row.canonical_schema),
      sessionStartedAt: nullableString(row.session_started_at),
      sessionUpdatedAt: nullableString(row.session_updated_at),
      status: String(row.status),
      lastSeenAt: String(row.last_seen_at),
      lastError: nullableString(row.last_error),
      classification: {
        kind: String(row.classification ?? "primary") as SessionClassification["kind"],
        reason: String(row.classification_reason ?? "legacy-unclassified"),
        policyVersion: String(row.classification_policy_version ?? CLASSIFICATION_POLICY_VERSION),
      },
    };
  }

  upsertGeneration(record: GenerationRecord): void {
    this.db.prepare(`INSERT INTO generations(source,native_session_id,canonical_hash,operation_id,state,queued_at,submitted_at,completed_at,attempt_count,error,retain_policy_version,repair)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source,native_session_id,canonical_hash) DO UPDATE SET
      operation_id=excluded.operation_id,state=excluded.state,queued_at=excluded.queued_at,submitted_at=excluded.submitted_at,
      completed_at=excluded.completed_at,attempt_count=excluded.attempt_count,error=excluded.error,
      retain_policy_version=excluded.retain_policy_version,repair=excluded.repair`).run(
      record.source, record.nativeSessionId, record.canonicalHash, record.operationId, record.state, record.queuedAt,
      record.submittedAt ?? null, record.completedAt ?? null, record.attemptCount, record.error ?? null,
      record.retainPolicyVersion ?? RETAIN_POLICY_VERSION, record.repair ? 1 : 0,
    );
    if (record.state === "completed") this.acknowledgeGeneration(record);
  }

  releaseBudget(operationId: string): void {
    this.transaction(() => {
      const reservation = this.db.prepare("SELECT input_tokens,estimated_cost_usd FROM budget_reservations WHERE operation_id=?").get(operationId) as Record<string, unknown> | undefined;
      if (!reservation) return;
      const budget = this.db.prepare("SELECT reserved_input_tokens,estimated_cost_usd FROM import_budget WHERE id=1").get() as Record<string, unknown>;
      this.db.prepare("UPDATE import_budget SET reserved_input_tokens=?, estimated_cost_usd=?, updated_at=? WHERE id=1").run(
        Math.max(0, Number(budget.reserved_input_tokens ?? 0) - Number(reservation.input_tokens ?? 0)),
        Math.max(0, Number(budget.estimated_cost_usd ?? 0) - Number(reservation.estimated_cost_usd ?? 0)),
        new Date().toISOString(),
      );
      this.db.prepare("DELETE FROM budget_reservations WHERE operation_id=?").run(operationId);
    });
  }

  upsertCleanupJob(record: CleanupJobRecord): void {
    this.db.prepare(`INSERT INTO cleanup_jobs(
      job_id,action,target_kind,source,native_session_id,document_id,canonical_hash,old_operation_id,new_operation_id,
      phase,last_error,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      target_kind=excluded.target_kind,canonical_hash=excluded.canonical_hash,old_operation_id=excluded.old_operation_id,
      new_operation_id=excluded.new_operation_id,phase=excluded.phase,last_error=excluded.last_error,
      updated_at=excluded.updated_at`).run(
      record.jobId, record.action, record.targetKind, record.source, record.nativeSessionId, record.documentId,
      record.canonicalHash ?? null, record.oldOperationId ?? null, record.newOperationId ?? null,
      record.phase, record.lastError ?? null, record.createdAt, record.updatedAt,
    );
  }

  getCleanupJob(jobId: string): CleanupJobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cleanup_jobs WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
    return row ? this.toCleanupJob(row) : undefined;
  }

  private toCleanupJob(row: Record<string, unknown>): CleanupJobRecord {
    return {
      jobId: String(row.job_id),
      action: "delete-document",
      targetKind: String(row.target_kind) as CleanupJobRecord["targetKind"],
      source: String(row.source) as Source,
      nativeSessionId: String(row.native_session_id),
      documentId: String(row.document_id),
      ...(nullableString(row.canonical_hash) ? { canonicalHash: String(row.canonical_hash) } : {}),
      ...(nullableString(row.old_operation_id) ? { oldOperationId: String(row.old_operation_id) } : {}),
      ...(nullableString(row.new_operation_id) ? { newOperationId: String(row.new_operation_id) } : {}),
      phase: String(row.phase) as CleanupJobRecord["phase"],
      ...(nullableString(row.last_error) ? { lastError: String(row.last_error) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  planCleanupJob(record: CleanupJobRecord): void {
    this.transaction(() => {
      const existing = this.db.prepare("SELECT job_id FROM cleanup_jobs WHERE job_id=?").get(record.jobId);
      if (existing) return;
      this.db.prepare("UPDATE generations SET state='cleanup_pending', error=? WHERE source=? AND native_session_id=? AND canonical_hash=? AND state IN ('queued','submitted','processing','completed','failed')").run(
        `Cleanup planned: ${record.targetKind}`, record.source, record.nativeSessionId, record.canonicalHash ?? "",
      );
      this.db.prepare("UPDATE sessions SET status='cleanup_pending', last_seen_at=?, last_error=? WHERE source=? AND native_session_id=? AND status NOT IN ('excluded_subagent','excluded_ambiguous','excluded_configured','cleanup_pending')").run(
        new Date().toISOString(), `Cleanup planned: ${record.targetKind}`, record.source, record.nativeSessionId,
      );
      this.db.prepare(`INSERT INTO cleanup_jobs(
        job_id,action,target_kind,source,native_session_id,document_id,canonical_hash,old_operation_id,new_operation_id,
        phase,last_error,created_at,updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.jobId, record.action, record.targetKind, record.source, record.nativeSessionId, record.documentId,
        record.canonicalHash ?? null, record.oldOperationId ?? null, record.newOperationId ?? null,
        record.phase, record.lastError ?? null, record.createdAt, record.updatedAt,
      );
    });
  }

  listCleanupJobs(): CleanupJobRecord[] {
    const rows = this.db.prepare("SELECT * FROM cleanup_jobs ORDER BY created_at,job_id").all() as Record<string, unknown>[];
    return rows.map((row) => this.toCleanupJob(row));
  }

  updateCleanupJob(jobId: string, phase: CleanupJobRecord["phase"], lastError?: string): void {
    this.db.prepare("UPDATE cleanup_jobs SET phase=?, last_error=?, updated_at=? WHERE job_id=?").run(phase, lastError ?? null, new Date().toISOString(), jobId);
  }

  getGeneration(source: Source, nativeSessionId: string, canonicalHash: string): GenerationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM generations WHERE source=? AND native_session_id=? AND canonical_hash=?").get(source, nativeSessionId, canonicalHash) as Record<string, unknown> | undefined;
    return row ? this.toGeneration(row) : undefined;
  }

  getActiveGenerationForDocument(source: Source, nativeSessionId: string): GenerationRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM generations WHERE source=? AND native_session_id=? AND state IN ('queued','submitted','processing') ORDER BY queued_at DESC LIMIT 1`).get(source, nativeSessionId) as Record<string, unknown> | undefined;
    return row ? this.toGeneration(row) : undefined;
  }

  /** Atomically claims one generation and prevents two versions of one document from running together. */
  claimGeneration(generation: GenerationRecord): boolean {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM generations WHERE source=? AND native_session_id=? AND canonical_hash=?").get(generation.source, generation.nativeSessionId, generation.canonicalHash) as Record<string, unknown> | undefined;
      if (!current) return false;
      const currentState = String(current.state) as GenerationState;
      if (!["queued", "failed", "submitted", "processing"].includes(currentState)) return false;
      const session = this.db.prepare("SELECT classification,status FROM sessions WHERE source=? AND native_session_id=?").get(generation.source, generation.nativeSessionId) as Record<string, unknown> | undefined;
      if (!session || String(session.classification ?? "primary") !== "primary" || ["excluded_subagent", "excluded_ambiguous", "excluded_configured", "ambiguous_preserved", "cleanup_pending"].includes(String(session.status))) return false;
      const other = this.db.prepare("SELECT operation_id FROM generations WHERE source=? AND native_session_id=? AND state IN ('submitted','processing') AND operation_id<>? LIMIT 1").get(generation.source, generation.nativeSessionId, generation.operationId) as Record<string, unknown> | undefined;
      if (other) return false;
      if (currentState === "queued" || currentState === "failed") {
        this.db.prepare("UPDATE generations SET state='processing', attempt_count=attempt_count+1, error=NULL WHERE source=? AND native_session_id=? AND canonical_hash=?").run(generation.source, generation.nativeSessionId, generation.canonicalHash);
      }
      return true;
    });
  }

  resetFailed(): number {
    const result = this.db.prepare("UPDATE generations SET state='queued', attempt_count=0, error=NULL WHERE state='failed' AND EXISTS (SELECT 1 FROM sessions WHERE sessions.source=generations.source AND sessions.native_session_id=generations.native_session_id AND sessions.classification='primary')").run();
    return Number(result.changes);
  }

  cancelQueued(): number {
    const result = this.db.prepare("UPDATE generations SET state='superseded', error='Cancelled before import' WHERE state IN ('queued','failed')").run();
    return Number(result.changes);
  }

  getLatestGeneration(source: Source, nativeSessionId: string): GenerationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM generations WHERE source=? AND native_session_id=? ORDER BY queued_at DESC LIMIT 1").get(source, nativeSessionId) as Record<string, unknown> | undefined;
    return row ? this.toGeneration(row) : undefined;
  }

  listQueued(limit = 100): GenerationRecord[] {
    const rows = this.db.prepare(`SELECT * FROM generations WHERE state IN ('queued','failed') ORDER BY queued_at ASC LIMIT ?`).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.toGeneration(row));
  }

  listGenerations(): GenerationRecord[] {
    return (this.db.prepare("SELECT * FROM generations ORDER BY queued_at").all() as Record<string, unknown>[]).map((row) => this.toGeneration(row));
  }

  setGenerationState(source: Source, nativeSessionId: string, hash: string, state: GenerationState, fields: { submittedAt?: string; completedAt?: string; attemptCount?: number; error?: string } = {}): void {
    this.db.prepare("UPDATE generations SET state=?, submitted_at=COALESCE(?, submitted_at), completed_at=COALESCE(?, completed_at), attempt_count=COALESCE(?, attempt_count), error=? WHERE source=? AND native_session_id=? AND canonical_hash=?").run(state, fields.submittedAt ?? null, fields.completedAt ?? null, fields.attemptCount ?? null, fields.error ?? null, source, nativeSessionId, hash);
    if (state === "completed") {
      const generation = this.getGeneration(source, nativeSessionId, hash);
      if (generation) this.acknowledgeGeneration(generation);
    }
  }

  supersedeOlder(source: Source, nativeSessionId: string, keepHash: string): void {
    this.db.prepare("UPDATE generations SET state='superseded' WHERE source=? AND native_session_id=? AND canonical_hash<>? AND state IN ('discovered','queued','failed')").run(source, nativeSessionId, keepHash);
  }

  markGenerationCleanupPending(source: Source, nativeSessionId: string, hash: string, reason: string): void {
    this.db.prepare("UPDATE generations SET state='cleanup_pending', error=? WHERE source=? AND native_session_id=? AND canonical_hash=? AND state IN ('queued','submitted','processing','completed','failed')").run(reason, source, nativeSessionId, hash);
  }

  markSessionGenerationsCleanupPending(source: Source, nativeSessionId: string, reason: string): number {
    const result = this.db.prepare("UPDATE generations SET state='cleanup_pending', error=? WHERE source=? AND native_session_id=? AND state IN ('queued','submitted','processing','completed','failed')").run(reason, source, nativeSessionId);
    return Number(result.changes);
  }

  finalizeExcluded(source: Source, nativeSessionId: string, hash: string, reason: string, classificationKind: "subagent" | "ambiguous" | "configured-exclusion" = "subagent"): void {
    this.transaction(() => {
      this.db.prepare("UPDATE generations SET state='excluded', error=?, submitted_at=NULL WHERE source=? AND native_session_id=? AND canonical_hash=? AND state='cleanup_pending'").run(reason, source, nativeSessionId, hash);
      this.db.prepare("UPDATE sessions SET classification=?, classification_reason=?, classification_policy_version=?, status=?, last_seen_at=?, last_error=? WHERE source=? AND native_session_id=?").run(classificationKind, reason, CLASSIFICATION_POLICY_VERSION, classificationKind === "subagent" ? "excluded_subagent" : classificationKind === "configured-exclusion" ? "excluded_configured" : "excluded_ambiguous", new Date().toISOString(), reason, source, nativeSessionId);
    });
  }

  requeueAfterCleanup(source: Source, nativeSessionId: string, hash: string, newOperationId: string, reason: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE generations SET operation_id=?, state='queued', submitted_at=NULL, completed_at=NULL, attempt_count=0, error=? WHERE source=? AND native_session_id=? AND canonical_hash=? AND state='cleanup_pending'").run(newOperationId, reason, source, nativeSessionId, hash);
      this.db.prepare("UPDATE sessions SET classification='primary', classification_reason=?, classification_policy_version=?, status='discovered', last_seen_at=?, last_error=NULL WHERE source=? AND native_session_id=? AND status NOT IN ('excluded_subagent','excluded_ambiguous','excluded_configured','cleanup_pending')").run("primary-replay-after-cleanup", CLASSIFICATION_POLICY_VERSION, new Date().toISOString(), source, nativeSessionId);
    });
  }

  private toGeneration(row: Record<string, unknown>): GenerationRecord {
    return {
      source: String(row.source) as Source,
      nativeSessionId: String(row.native_session_id),
      canonicalHash: String(row.canonical_hash),
      operationId: String(row.operation_id),
      state: String(row.state) as GenerationState,
      queuedAt: String(row.queued_at),
      submittedAt: nullableString(row.submitted_at),
      completedAt: nullableString(row.completed_at),
      attemptCount: Number(row.attempt_count),
      error: nullableString(row.error),
      retainPolicyVersion: String(row.retain_policy_version ?? "1"),
      repair: Number(row.repair) === 1,
    };
  }

  upsertOperation(record: OperationRecord): void {
    this.db.prepare(`INSERT INTO operations(operation_id,document_id,canonical_hash,hindsight_status,submitted_at,last_polled_at,retry_count,response_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET hindsight_status=excluded.hindsight_status, submitted_at=COALESCE(excluded.submitted_at,operations.submitted_at), last_polled_at=COALESCE(excluded.last_polled_at,operations.last_polled_at), retry_count=excluded.retry_count, response_summary=excluded.response_summary`).run(
      record.operationId, record.documentId, record.canonicalHash, record.hindsightStatus ?? null, record.submittedAt ?? null, record.lastPolledAt ?? null, record.retryCount, record.responseSummary ?? null,
    );
  }

  getOperation(operationId: string): OperationRecord | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE operation_id=?").get(operationId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { operationId: String(row.operation_id), documentId: String(row.document_id), canonicalHash: String(row.canonical_hash), hindsightStatus: nullableString(row.hindsight_status), submittedAt: nullableString(row.submitted_at), lastPolledAt: nullableString(row.last_polled_at), retryCount: Number(row.retry_count), responseSummary: nullableString(row.response_summary) };
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS count FROM sessions GROUP BY status").all() as Record<string, unknown>[]) out[String(row.status)] = Number(row.count);
    return out;
  }
}
