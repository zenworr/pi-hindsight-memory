import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterLoadOptions, CanonicalSession, SessionClassification, SessionReference, SourceFingerprint } from "../common/types.js";
import { documentIdFor, sha256 } from "../common/hashing.js";
import { CLASSIFICATION_POLICY_VERSION } from "../common/types.js";
import { actionText } from "../canonical/actions.js";
import { isMemorySearchToolName } from "../canonical/injected-memory.js";
import {
  addTextTurn,
  completeSession,
  createSpool,
  firstJsonLine,
  forEachJsonLine,
  hasToolCall,
  isoFromMilliseconds,
  maxIso,
  metadataBase,
  pathFingerprint,
  stableFallbackId,
  stringOrUndefined,
  textParts,
  toolBlocks,
  walkFiles,
  type SessionAdapter,
} from "./adapter.js";

interface CodexRecord { timestamp?: string | number; type?: string; payload?: Record<string, unknown>; id?: string; }

function filenameTimestamp(filePath: string): string {
  const match = path.basename(filePath).match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(?:[0-9a-f-]{20,})\.jsonl$/i);
  if (!match) return "1970-01-01T00:00:00.000Z";
  return `${match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3") }Z`;
}

interface CodexMeta { id?: string; threadId?: string; startedAt: string; cwd?: string; parentId?: string; threadSource?: string; explicitSubagent: boolean; metadataRecognized: boolean; sourceIsObject: boolean; sourceName?: string; agentRole?: string; agentNickname?: string; }

function getMeta(filePath: string, first: unknown): CodexMeta {
  const record = first && typeof first === "object" ? first as CodexRecord : {};
  const metadataRecognized = stringOrUndefined(record.type)?.toLowerCase() === "session_meta" && Boolean(record.payload && typeof record.payload === "object");
  const payload = record.payload ?? {};
  const sourceValue = payload.source;
  const source = sourceValue && typeof sourceValue === "object" ? sourceValue as Record<string, unknown> : undefined;
  const threadSource = stringOrUndefined(payload.thread_source)?.toLowerCase();
  const explicitSubagent = threadSource === "subagent" || sourceValue === "subagent" || source?.subagent != null;
  const threadId = stringOrUndefined(payload.session_id);
  const id = stringOrUndefined(payload.id) ?? threadId;
  const startedAt = isoFromMilliseconds(record.timestamp ?? payload.timestamp, filenameTimestamp(filePath));
  return {
    id,
    threadId,
    startedAt,
    cwd: stringOrUndefined(payload.cwd),
    parentId: stringOrUndefined(payload.parent_thread_id),
    threadSource,
    explicitSubagent,
    metadataRecognized,
    sourceIsObject: Boolean(source),
    sourceName: typeof sourceValue === "string" ? sourceValue.toLowerCase() : undefined,
    agentRole: stringOrUndefined(payload.agent_role),
    agentNickname: stringOrUndefined(payload.agent_nickname),
  };
}

function metaClassification(meta: CodexMeta): SessionClassification {
  if (!meta.metadataRecognized) return { kind: "ambiguous", reason: "codex-unrecognized-session-metadata", policyVersion: CLASSIFICATION_POLICY_VERSION };
  if (meta.explicitSubagent) return { kind: "subagent", reason: "codex-explicit-subagent-thread-source", policyVersion: CLASSIFICATION_POLICY_VERSION, parentSessionId: meta.parentId };
  if (meta.parentId || meta.agentRole || meta.agentNickname) return { kind: "ambiguous", reason: "codex-incomplete-subagent-marker", policyVersion: CLASSIFICATION_POLICY_VERSION, parentSessionId: meta.parentId };
  if (meta.sourceIsObject) return { kind: "ambiguous", reason: "codex-unrecognized-object-source", policyVersion: CLASSIFICATION_POLICY_VERSION };
  if (meta.threadSource && meta.threadSource !== "user") return { kind: "ambiguous", reason: "codex-unrecognized-thread-source", policyVersion: CLASSIFICATION_POLICY_VERSION };
  if (meta.sourceName && !["exec", "cli"].includes(meta.sourceName)) return { kind: "ambiguous", reason: "codex-unrecognized-source", policyVersion: CLASSIFICATION_POLICY_VERSION };
  return { kind: "primary", reason: "codex-primary-session", policyVersion: CLASSIFICATION_POLICY_VERSION };
}

function messageRole(payload: Record<string, unknown>): string | undefined {
  return stringOrUndefined(payload.role)?.toLowerCase();
}

function isVisiblePayloadType(type: string): boolean {
  return type === "message" || type === "function_call" || type === "custom_tool_call" || type === "local_shell_call" || type === "web_search_call";
}

export class CodexAdapter implements SessionAdapter {
  readonly source = "codex" as const;
  private threadLabels: Promise<Map<string, string>> | undefined;
  constructor(private readonly root: string, private readonly stateDatabase?: string) {}

  private async labels(): Promise<Map<string, string>> {
    if (!this.threadLabels) {
      this.threadLabels = Promise.resolve().then(() => {
        const labels = new Map<string, string>();
        if (!this.stateDatabase) return labels;
        let db: DatabaseSync | undefined;
        try {
          db = new DatabaseSync(this.stateDatabase, { readOnly: true, timeout: 1000 });
          db.exec("PRAGMA query_only = ON");
          const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((row) => row.name));
          if (!columns.has("id") || (!columns.has("name") && !columns.has("title"))) throw new Error("Unsupported Codex label columns");
          const fields = `id, ${columns.has("name") ? "name" : "NULL"} AS name, ${columns.has("title") ? "title" : "NULL"} AS title`;
          for (const row of db.prepare(`SELECT ${fields} FROM threads`).iterate() as Iterable<Record<string, unknown>>) {
            const id = stringOrUndefined(row.id);
            const label = stringOrUndefined(row.name) ?? stringOrUndefined(row.title);
            if (id && label) labels.set(id, label);
          }
        } catch { throw new Error("Codex label database is unavailable or has an unsupported schema; session discovery is blocked"); }
        finally { db?.close(); }
        return labels;
      });
    }
    return this.threadLabels;
  }

  private async labelFor(meta: CodexMeta, refresh = false): Promise<string | undefined> {
    if (refresh) this.threadLabels = undefined;
    const labels = await this.labels();
    return (meta.threadId && labels.get(meta.threadId)) ?? (meta.id && labels.get(meta.id));
  }

  async classify(reference: SessionReference): Promise<SessionClassification> {
    const first = await firstJsonLine(reference.locator);
    const meta = getMeta(reference.locator, first);
    const label = await this.labelFor(meta, true);
    return { ...metaClassification(meta), ...(label ? { label } : {}) };
  }

  async *discover(): AsyncIterable<SessionReference> {
    this.threadLabels = undefined;
    const files = await walkFiles(this.root);
    for (const sourcePath of files) {
      const first = await firstJsonLine(sourcePath);
      const meta = getMeta(sourcePath, first);
      const identityIsFallback = !meta.id;
      const nativeId = meta.id ?? stableFallbackId(this.source, path.relative(this.root, sourcePath), meta.startedAt);
      const metadata = metadataBase(this.source, nativeId, sourcePath);
      const label = await this.labelFor(meta);
      if (meta.cwd) metadata.cwd = meta.cwd;
      if (meta.parentId) metadata.parent_session_id = meta.parentId;
      if (label) metadata.title = label;
      yield { source: this.source, nativeSessionId: nativeId, locator: sourcePath, sourcePath, sessionStartedAt: meta.startedAt, metadata, identityIsFallback, classification: { ...metaClassification(meta), ...(label ? { label } : {}) }, ...(label ? { sessionLabel: label } : {}) };
    }
  }

  async fingerprint(reference: SessionReference): Promise<SourceFingerprint> {
    const fingerprint = await pathFingerprint(reference.locator, reference.locator);
    const first = await firstJsonLine(reference.locator);
    const label = await this.labelFor(getMeta(reference.locator, first), true);
    return label ? { ...fingerprint, sampleHash: sha256(`${fingerprint.sampleHash}\nlabel:${label}`) } : fingerprint;
  }

  async load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession> {
    const sourcePath = reference.locator;
    const first = await firstJsonLine(sourcePath);
    const meta = getMeta(sourcePath, first);
    const nativeId = reference.nativeSessionId || meta.id || stableFallbackId(this.source, path.relative(this.root, sourcePath), meta.startedAt);
    const id = documentIdFor(this.source, nativeId);
    const metadata = { ...reference.metadata, native_session_id: nativeId, source_path: sourcePath };
    const label = reference.sessionLabel ?? await this.labelFor(meta);
    if (meta.cwd) metadata.cwd = meta.cwd;
    if (meta.parentId) metadata.parent_session_id = meta.parentId;
    if (label) metadata.title = label;
    const sessionClassification = reference.classification ?? metaClassification(meta);
    const spool = await createSpool(options, id, meta.startedAt);
    let updatedAt = meta.startedAt;
    let memoryPending = false;
    let sequentialPending = false;
    const pendingByEntry = new Map<string, boolean>();
    let sequence = 0;
    const seenMessageKeys = new Set<string>();

    try {
      await forEachJsonLine(sourcePath, async (raw) => {
        sequence += 1;
        const record = raw && typeof raw === "object" ? raw as CodexRecord : {};
        const timestamp = isoFromMilliseconds(record.timestamp, meta.startedAt);
        updatedAt = maxIso(updatedAt, timestamp);
        const type = stringOrUndefined(record.type)?.toLowerCase() ?? "";
        const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
        if (type !== "response_item") return;
        const payloadType = stringOrUndefined(payload.type)?.toLowerCase() ?? "";
        if (!isVisiblePayloadType(payloadType)) return;
        const nativeId = stringOrUndefined(payload.id) ?? stringOrUndefined(record.id) ?? `line:${sequence}`;
        const parentId = stringOrUndefined(payload.parent_id) ?? stringOrUndefined(payload.parentId);
        if (payloadType === "message") {
          const role = messageRole(payload);
          if (role !== "user" && role !== "assistant") return;
          const key = `${role}\n${JSON.stringify(payload.content)}\n${timestamp}`;
          if (seenMessageKeys.has(key)) return;
          seenMessageKeys.add(key);
          const inheritedPending = parentId ? pendingByEntry.get(parentId) ?? false : sequentialPending;
          memoryPending = inheritedPending;
          const provenance = memoryPending ? "memory-assisted" as const : "original" as const;
          const content = payload.content;
          for (const text of textParts(content)) {
            if (await addTextTurn(spool, role, text, timestamp, nativeId, parentId, role === "assistant" ? provenance : undefined) && role === "user") memoryPending = false;
          }
          const blocks = toolBlocks(content);
          for (const block of blocks) await addTextTurn(spool, "action", actionText(block.name, block.input), timestamp, nativeId, parentId);
          if (hasToolCall(content) || blocks.some((block) => isMemorySearchToolName(block.name))) memoryPending = true;
          pendingByEntry.set(nativeId, memoryPending);
          sequentialPending = memoryPending;
          return;
        }
        if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(payloadType)) {
          const name = stringOrUndefined(payload.name) ?? stringOrUndefined(payload.tool_name) ?? payloadType;
          const input = payload.arguments ?? payload.input ?? payload.parameters ?? payload;
          await addTextTurn(spool, "action", actionText(name, input), timestamp, nativeId, parentId);
          if (isMemorySearchToolName(name)) memoryPending = true;
          pendingByEntry.set(nativeId, memoryPending);
          sequentialPending = memoryPending;
        }
      }, { signal: options.signal });
      return await completeSession({ source: this.source, nativeSessionId: nativeId, sourceLocator: sourcePath, metadata, startedAt: meta.startedAt, updatedAt, spool, options, classification: sessionClassification, sessionLabel: label });
    } catch (error) {
      await spool.cleanup().catch(() => undefined);
      throw error;
    }
  }
}
