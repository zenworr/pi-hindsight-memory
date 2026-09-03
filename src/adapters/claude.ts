import path from "node:path";
import type { AdapterLoadOptions, CanonicalSession, SessionClassification, SessionReference, SourceFingerprint } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
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

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  timestamp?: string | number;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

function filenameTimestamp(filePath: string): string {
  const statName = path.basename(filePath);
  const dateMatch = statName.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00.000Z` : "1970-01-01T00:00:00.000Z";
}

function metaFor(filePath: string, first: unknown): { id?: string; startedAt: string; cwd?: string; isSidechain?: boolean; agentId?: string } {
  const record = first && typeof first === "object" ? first as ClaudeRecord : {};
  return {
    id: stringOrUndefined(record.sessionId),
    startedAt: isoFromMilliseconds(record.timestamp, filenameTimestamp(filePath)),
    cwd: stringOrUndefined(record.cwd),
    isSidechain: record.isSidechain === true,
    agentId: stringOrUndefined(record.agentId),
  };
}

function metaClassification(filePath: string, meta: { isSidechain?: boolean; agentId?: string }): SessionClassification {
  if (meta.isSidechain) return { kind: "subagent", reason: "claude-explicit-sidechain", policyVersion: CLASSIFICATION_POLICY_VERSION };
  const relative = filePath.toLowerCase();
  const agentPath = path.basename(filePath).startsWith("agent-") || relative.includes(`${path.sep}subagents${path.sep}`);
  if (meta.agentId && agentPath) return { kind: "subagent", reason: "claude-agent-id-and-agent-path", policyVersion: CLASSIFICATION_POLICY_VERSION };
  if (meta.agentId || agentPath) return { kind: "ambiguous", reason: "claude-incomplete-sidechain-marker", policyVersion: CLASSIFICATION_POLICY_VERSION };
  return { kind: "primary", reason: "claude-primary-session", policyVersion: CLASSIFICATION_POLICY_VERSION };
}

function shouldSkip(record: ClaudeRecord): boolean {
  const type = stringOrUndefined(record.type)?.toLowerCase() ?? "";
  return record.isSidechain === true || record.isMeta === true || [
    "progress",
    "file-history-snapshot",
    "queue-operation",
    "system",
    "summary",
  ].includes(type);
}

export class ClaudeAdapter implements SessionAdapter {
  readonly source = "claude" as const;
  constructor(private readonly root: string) {}

  async classify(reference: SessionReference): Promise<SessionClassification> {
    const first = await firstJsonLine(reference.locator);
    return metaClassification(reference.locator, metaFor(reference.locator, first));
  }

  async *discover(): AsyncIterable<SessionReference> {
    const files = await walkFiles(this.root);
    for (const sourcePath of files) {
      let first: unknown;
      try { first = await firstJsonLine(sourcePath); } catch { first = undefined; }
      const meta = metaFor(sourcePath, first);
      const identityIsFallback = !meta.id;
      const nativeId = meta.id ?? stableFallbackId(this.source, path.relative(this.root, sourcePath), meta.startedAt);
      const metadata = metadataBase(this.source, nativeId, sourcePath);
      if (meta.cwd) metadata.cwd = meta.cwd;
      yield { source: this.source, nativeSessionId: nativeId, locator: sourcePath, sourcePath, sessionStartedAt: meta.startedAt, metadata, identityIsFallback, classification: metaClassification(sourcePath, meta) };
    }
  }

  async fingerprint(reference: SessionReference): Promise<SourceFingerprint> {
    return pathFingerprint(reference.locator, reference.locator);
  }

  async load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession> {
    const sourcePath = reference.locator;
    const first = await firstJsonLine(sourcePath);
    const meta = metaFor(sourcePath, first);
    const nativeId = reference.nativeSessionId || meta.id || stableFallbackId(this.source, path.relative(this.root, sourcePath), meta.startedAt);
    const id = documentIdFor(this.source, nativeId);
    const metadata = { ...reference.metadata, native_session_id: nativeId, source_path: sourcePath };
    if (meta.cwd) metadata.cwd = meta.cwd;
    const sessionClassification = reference.classification ?? metaClassification(sourcePath, meta);
    const spool = await createSpool(options, id, meta.startedAt);
    let updatedAt = meta.startedAt;
    let memoryPending = false;
    let sequentialPending = false;
    const pendingByEntry = new Map<string, boolean>();
    let sequence = 0;

    try {
      await forEachJsonLine(sourcePath, async (raw) => {
        sequence += 1;
        const record = raw && typeof raw === "object" ? raw as ClaudeRecord : {};
        const timestamp = isoFromMilliseconds(record.timestamp, meta.startedAt);
        updatedAt = maxIso(updatedAt, timestamp);
        if (shouldSkip(record)) return;
        const role = stringOrUndefined(record.message?.role)?.toLowerCase();
        if (role !== "user" && role !== "assistant") return;
        const content = record.message?.content;
        const blocks = toolBlocks(content);
        const nativeId = stringOrUndefined(record.uuid) ?? `line:${sequence}`;
        const parentId = stringOrUndefined(record.parentUuid ?? undefined);
        memoryPending = parentId ? pendingByEntry.get(parentId) ?? false : sequentialPending;
        const provenance = memoryPending ? "memory-assisted" as const : "original" as const;
        for (const text of textParts(content)) await addTextTurn(spool, role, text, timestamp, nativeId, parentId, role === "assistant" ? provenance : undefined);
        for (const block of blocks) await addTextTurn(spool, "action", actionText(block.name, block.input), timestamp, nativeId, parentId);
        if (memoryPending && textParts(content).length > 0) memoryPending = false;
        if (hasToolCall(content) || blocks.some((block) => isMemorySearchToolName(block.name))) memoryPending = true;
        pendingByEntry.set(nativeId, memoryPending);
        sequentialPending = memoryPending;
      });
      return await completeSession({ source: this.source, nativeSessionId: nativeId, sourceLocator: sourcePath, metadata, startedAt: meta.startedAt, updatedAt, spool, options, classification: sessionClassification });
    } catch (error) {
      await spool.cleanup().catch(() => undefined);
      throw error;
    }
  }
}
