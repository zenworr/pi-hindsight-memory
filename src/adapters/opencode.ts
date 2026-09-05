import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AdapterLoadOptions, CanonicalSession, SessionClassification, SessionReference, SourceFingerprint } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
import { CLASSIFICATION_POLICY_VERSION } from "../common/types.js";
import { actionText } from "../canonical/actions.js";
import { isMemorySearchToolName } from "../canonical/injected-memory.js";
import {
  addTextTurn,
  completeSession,
  createSpool,
  isoFromMilliseconds,
  maxIso,
  metadataBase,
  stringOrUndefined,
  type SessionAdapter,
} from "./adapter.js";

interface DbRow { [key: string]: unknown; }

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* report no record content */ }
  throw new Error("OpenCode record is not a valid JSON object");
}

function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function fallbackStart(): string { return "1970-01-01T00:00:00.000Z"; }
function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as DbRow[]).map((row) => String(row.name)));
}

function sessionSelect(db: DatabaseSync): string {
  const columns = tableColumns(db, "session");
  const required = ["id", "time_created", "time_updated"];
  for (const column of required) if (!columns.has(column)) throw new Error(`OpenCode session table has no required column: ${column}`);
  const optional = (column: string) => columns.has(column) ? quoteIdentifier(column) : "NULL";
  const classificationCapable = columns.has("parent_id") && columns.has("title") ? 1 : 0;
  return `SELECT ${quoteIdentifier("id")} AS id, ${optional("parent_id")} AS parent_id, ${optional("project_id")} AS project_id, ${optional("directory")} AS directory, ${optional("title")} AS title, ${optional("agent")} AS agent, ${optional("model")} AS model, ${quoteIdentifier("time_created")} AS time_created, ${quoteIdentifier("time_updated")} AS time_updated, ${classificationCapable} AS classification_capable FROM ${quoteIdentifier("session")}`;
}

function sessionClassification(row: DbRow): SessionClassification {
  if (Number(row.classification_capable) !== 1) return { kind: "ambiguous", reason: "opencode-missing-classification-columns", policyVersion: CLASSIFICATION_POLICY_VERSION };
  const parentId = stringOrUndefined(row.parent_id);
  const title = stringOrUndefined(row.title);
  const label = title ? { label: title } : {};
  const generatedSubagentTitle = Boolean(title && / \(@[^()]+ subagent\)$/i.test(title));
  if (parentId && generatedSubagentTitle) return { kind: "subagent", reason: "opencode-parent-and-generated-subagent-title", policyVersion: CLASSIFICATION_POLICY_VERSION, ...label, parentSessionId: parentId };
  if (parentId) return { kind: "ambiguous", reason: "opencode-parent-without-generated-subagent-title", policyVersion: CLASSIFICATION_POLICY_VERSION, ...label, parentSessionId: parentId };
  if (generatedSubagentTitle) return { kind: "ambiguous", reason: "opencode-generated-subagent-title-without-parent", policyVersion: CLASSIFICATION_POLICY_VERSION, ...label };
  return { kind: "primary", reason: "opencode-root-session", policyVersion: CLASSIFICATION_POLICY_VERSION, ...label };
}

function sessionMetadata(databasePath: string, row: DbRow, id: string) {
  const metadata = metadataBase("opencode", id, databasePath);
  const fields: Array<[keyof typeof metadata, unknown]> = [
    ["cwd", row.directory], ["title", row.title], ["parent_session_id", row.parent_id],
    ["project_id", row.project_id], ["agent", row.agent], ["model", row.model],
  ];
  for (const [key, value] of fields) { const text = stringOrUndefined(value); if (text) metadata[key] = text; }
  return metadata;
}

function openReadOnly(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
  db.exec("PRAGMA query_only = ON");
  const row = db.prepare("PRAGMA query_only").get() as DbRow;
  if (Number(row.query_only) !== 1) { db.close(); throw new Error("OpenCode database did not enter query-only mode"); }
  return db;
}

function addFingerprintRows(hash: crypto.Hash, db: DatabaseSync, sql: string, args: string[]): void {
  for (const raw of db.prepare(sql).iterate(...args)) {
    const row = raw as DbRow;
    const data = String(row.data);
    hash.update(JSON.stringify([row.id, row.time_created, row.time_updated, Buffer.byteLength(data)]));
    hash.update("\0").update(data).update("\n");
  }
}

export class OpenCodeAdapter implements SessionAdapter {
  readonly source = "opencode" as const;
  constructor(private readonly databasePath: string) {}

  async *discover(): AsyncIterable<SessionReference> {
    const db = openReadOnly(this.databasePath);
    let rows: DbRow[];
    try {
      // Materialize only the small session-reference list, then close the snapshot before the
      // scanner normalizes each potentially large conversation.
      rows = db.prepare(`${sessionSelect(db)} ORDER BY time_created ASC, id ASC`).all() as DbRow[];
    } finally { db.close(); }
    for (const row of rows) {
      const id = stringOrUndefined(row.id);
      if (!id) continue;
      const startedAt = isoFromMilliseconds(row.time_created, fallbackStart());
      const updatedAt = isoFromMilliseconds(row.time_updated, startedAt);
      const label = stringOrUndefined(row.title);
      yield { source: this.source, nativeSessionId: id, locator: `${this.databasePath}#${id}`, sourcePath: this.databasePath, sessionStartedAt: startedAt, sessionUpdatedAt: updatedAt, metadata: sessionMetadata(this.databasePath, row, id), classification: sessionClassification(row), ...(label ? { sessionLabel: label } : {}) };
    }
  }

  async classify(reference: SessionReference): Promise<SessionClassification> {
    const db = openReadOnly(this.databasePath);
    try {
      const row = db.prepare(`${sessionSelect(db)} WHERE id = ?`).get(reference.nativeSessionId) as DbRow | undefined;
      if (!row) return { kind: "ambiguous", reason: "opencode-session-disappeared-during-classification", policyVersion: CLASSIFICATION_POLICY_VERSION };
      return sessionClassification(row);
    } finally { db.close(); }
  }

  async fingerprint(reference: SessionReference): Promise<SourceFingerprint> {
    const db = openReadOnly(this.databasePath);
    let inTransaction = false;
    try {
      db.exec("BEGIN"); inTransaction = true;
      const row = db.prepare(`${sessionSelect(db)} WHERE id = ?`).get(reference.nativeSessionId) as DbRow | undefined;
      if (!row) throw new Error(`OpenCode session not found: ${reference.nativeSessionId}`);
      const hash = crypto.createHash("sha256");
      hash.update(JSON.stringify(row)).update("\nmessages\n");
      addFingerprintRows(hash, db, "SELECT id,time_created,time_updated,data FROM message WHERE session_id=? ORDER BY time_created,id", [reference.nativeSessionId]);
      hash.update("\nparts\n");
      addFingerprintRows(hash, db, "SELECT id,time_created,time_updated,data FROM part WHERE session_id=? ORDER BY time_created,id", [reference.nativeSessionId]);
      db.exec("COMMIT"); inTransaction = false;
      return { size: 0, mtimeMs: numberValue(row.time_updated) ?? 0, sampleHash: hash.digest("hex"), stableLocator: `${this.databasePath}#${reference.nativeSessionId}` };
    } catch (error) {
      if (inTransaction) { try { db.exec("ROLLBACK"); } catch { /* preserve original error */ } }
      throw error;
    } finally { db.close(); }
  }

  async load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession> {
    const db = openReadOnly(this.databasePath);
    const sessionId = reference.nativeSessionId;
    let spool: Awaited<ReturnType<typeof createSpool>> | undefined;
    let inTransaction = false;
    try {
      db.exec("BEGIN"); inTransaction = true;
      const session = db.prepare(`${sessionSelect(db)} WHERE id = ?`).get(sessionId) as DbRow | undefined;
      if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);
      const startedAt = isoFromMilliseconds(session.time_created, reference.sessionStartedAt ?? fallbackStart());
      let updatedAt = isoFromMilliseconds(session.time_updated, startedAt);
      const id = documentIdFor(this.source, sessionId);
      const metadata = sessionMetadata(this.databasePath, session, sessionId);
      const sessionLabel = reference.sessionLabel ?? stringOrUndefined(session.title);
      const classification = reference.classification ?? sessionClassification(session);
      spool = await createSpool(options, id, startedAt);
      const messageStatement = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC");
      const partStatement = db.prepare("SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC");
      const pendingByMessage = new Map<string, boolean>();
      let sequentialPending = false;

      for (const rawMessage of messageStatement.iterate(sessionId)) {
        options.signal?.throwIfAborted();
        const message = rawMessage as DbRow;
        const messageId = stringOrUndefined(message.id) ?? `message:${String(message.time_created)}`;
        const data = parseObject(message.data);
        const role = stringOrUndefined(data.role)?.toLowerCase();
        if (role !== "user" && role !== "assistant") continue;
        const time = data.time && typeof data.time === "object" ? data.time as Record<string, unknown> : {};
        const timestamp = isoFromMilliseconds(time.created ?? message.time_created, startedAt);
        updatedAt = maxIso(updatedAt, timestamp);
        const parentId = stringOrUndefined(data.parentID ?? data.parent_id);
        let pending: boolean = parentId ? pendingByMessage.get(parentId) ?? false : sequentialPending;
        const textParts: string[] = [];
        const actions: Array<{ name: string; input: unknown }> = [];
        let hasMemoryCall = false;
        for (const rawPart of partStatement.iterate(messageId)) {
          options.signal?.throwIfAborted();
          const part = rawPart as DbRow;
          const partData = parseObject(part.data);
          const partType = stringOrUndefined(partData.type)?.toLowerCase() ?? "";
          if (partType === "text") {
            const text = stringOrUndefined(partData.text);
            if (text) textParts.push(text);
          } else if (["tool", "tool-call", "tool_call"].includes(partType)) {
            const name = stringOrUndefined(partData.tool) ?? stringOrUndefined(partData.name) ?? "tool";
            const state = partData.state && typeof partData.state === "object" ? partData.state as Record<string, unknown> : {};
            actions.push({ name, input: partData.input ?? state.input ?? state.raw ?? partData });
            if (isMemorySearchToolName(name)) hasMemoryCall = true;
          }
        }
        const provenance = pending ? "memory-assisted" as const : "original" as const;
        for (const text of textParts) {
          if (await addTextTurn(spool, role, text, timestamp, messageId, parentId, role === "assistant" ? provenance : undefined) && role === "user") pending = false;
        }
        for (const action of actions) await addTextTurn(spool, "action", actionText(action.name, action.input), timestamp, messageId, parentId);
        if (hasMemoryCall) pending = true;
        pendingByMessage.set(messageId, pending);
        sequentialPending = pending;
      }
      db.exec("COMMIT"); inTransaction = false;
      return await completeSession({ source: this.source, nativeSessionId: sessionId, sourceLocator: this.databasePath, metadata, startedAt, updatedAt, spool, options, classification, sessionLabel });
    } catch (error) {
      if (inTransaction) { try { db.exec("ROLLBACK"); } catch { /* preserve original error */ } }
      if (spool) await spool.cleanup().catch(() => undefined);
      throw error;
    } finally { db.close(); }
  }
}
