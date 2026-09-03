import fs from "node:fs";
import path from "node:path";
import type { AdapterLoadOptions, SessionClassification, SessionReference, SourceFingerprint } from "../common/types.js";
import type { CanonicalSession } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
import { CLASSIFICATION_POLICY_VERSION } from "../common/types.js";
import { actionText } from "../canonical/actions.js";
import { isMemorySearchToolName } from "../canonical/injected-memory.js";
import {
  addTextTurn,
  completeSession,
  createSpool,
  firstJsonLine,
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

interface PiEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string | number;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

function filenameTimestamp(filePath: string): string {
  const match = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) return "1970-01-01T00:00:00.000Z";
  return match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

function childSessionLayout(root: string, filePath: string): boolean {
  const parts = path.relative(root, filePath).split(path.sep);
  return path.basename(filePath) === "session.jsonl" && parts.length >= 3 && /^run-\d+$/.test(parts[parts.length - 2] ?? "");
}

function taskChildLayout(root: string, filePath: string): boolean {
  return path.relative(root, filePath).split(path.sep).includes("tasks");
}

async function sessionInfoName(filePath: string): Promise<string | undefined> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as PiEntry;
        if (value.type?.toLowerCase() === "session_info") return stringOrUndefined(value.name);
      } catch { /* discovery will report malformed records during loading */ }
    }
    return undefined;
  } finally { await handle.close(); }
}

function classification(kind: "primary" | "subagent" | "ambiguous", reason: string, label?: string, parentSessionId?: string): SessionClassification {
  return { kind, reason, policyVersion: CLASSIFICATION_POLICY_VERSION, ...(label ? { label } : {}), ...(parentSessionId ? { parentSessionId } : {}) };
}

function classifyPi(root: string, filePath: string, name: string | undefined, parentSessionId: string | undefined): SessionClassification {
  const legacySubagentName = Boolean(name && /^subagent-/i.test(name));
  const generatedAgentName = Boolean(name && /^[a-z][a-z0-9_-]*#[0-9a-f]{8}$/i.test(name));
  const nested = childSessionLayout(root, filePath);
  const taskChild = taskChildLayout(root, filePath);
  const parented = Boolean(parentSessionId);
  if (nested && legacySubagentName) return classification("subagent", "pi-child-layout-and-session-info-subagent-name", name, parentSessionId);
  if (parented && generatedAgentName) return classification("subagent", "pi-parent-session-and-generated-agent-name", name, parentSessionId);
  if (parented && legacySubagentName) return classification("subagent", "pi-parent-session-and-session-info-subagent-name", name, parentSessionId);
  if (parented && taskChild) return classification("subagent", "pi-parent-session-and-task-child-layout", name, parentSessionId);
  if (parented) return classification("ambiguous", "pi-parent-session-without-agent-marker", name, parentSessionId);
  if (nested) return classification("ambiguous", "pi-child-layout-without-subagent-name", name);
  if (legacySubagentName || generatedAgentName) return classification("ambiguous", "pi-agent-name-without-child-marker", name);
  return classification("primary", "pi-primary-session", name);
}

function headerInfo(filePath: string, value: unknown): { id?: string; startedAt: string; cwd?: string; parentSessionId?: string } {
  const entry = value && typeof value === "object" ? value as PiEntry : {};
  const id = stringOrUndefined(entry.id);
  const startedAt = isoFromMilliseconds(entry.timestamp, filenameTimestamp(filePath));
  return { id, startedAt, cwd: stringOrUndefined(entry.cwd), parentSessionId: stringOrUndefined(entry.parentSession) };
}

function isDerivedEntry(type: string): boolean {
  return [
    "session",
    "compaction",
    "compaction_summary",
    "branch_summary",
    "model_change",
    "thinking_level_change",
    "label",
    "session_info",
    "custom",
    "custom_message",
  ].includes(type.toLowerCase());
}

export class PiAdapter implements SessionAdapter {
  readonly source = "pi" as const;
  constructor(private readonly root: string) {}

  async classify(reference: SessionReference): Promise<SessionClassification> {
    const header = headerInfo(reference.locator, await firstJsonLine(reference.locator));
    return classifyPi(this.root, reference.locator, await sessionInfoName(reference.locator), header.parentSessionId);
  }

  async *discover(): AsyncIterable<SessionReference> {
    const files = await walkFiles(this.root);
    for (const sourcePath of files) {
      let first: unknown;
      try { first = await firstJsonLine(sourcePath); } catch { first = undefined; }
      const header = headerInfo(sourcePath, first);
      const identityIsFallback = !header.id;
      const nativeId = header.id ?? stableFallbackId(this.source, path.relative(this.root, sourcePath), header.startedAt);
      const metadata = metadataBase(this.source, nativeId, sourcePath);
      const name = await sessionInfoName(sourcePath);
      if (header.cwd) metadata.cwd = header.cwd;
      if (name) metadata.title = name;
      yield {
        source: this.source,
        nativeSessionId: nativeId,
        locator: sourcePath,
        sourcePath,
        sessionStartedAt: header.startedAt,
        metadata,
        identityIsFallback,
        classification: classifyPi(this.root, sourcePath, name, header.parentSessionId),
        ...(name ? { sessionLabel: name } : {}),
      };
    }
  }

  async fingerprint(reference: SessionReference): Promise<SourceFingerprint> {
    return pathFingerprint(reference.locator, reference.locator);
  }

  async load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession> {
    const sourcePath = reference.locator;
    const first = await firstJsonLine(sourcePath);
    const header = headerInfo(sourcePath, first);
    const nativeId = reference.nativeSessionId || header.id || stableFallbackId(this.source, path.relative(this.root, sourcePath), header.startedAt);
    const id = documentIdFor(this.source, nativeId);
    const metadata = { ...reference.metadata, native_session_id: nativeId, source_path: sourcePath };
    const label = reference.sessionLabel ?? await sessionInfoName(sourcePath);
    if (header.cwd) metadata.cwd = header.cwd;
    if (label) metadata.title = label;
    const sessionClassification = reference.classification ?? classifyPi(this.root, sourcePath, label, header.parentSessionId);
    const spool = await createSpool(options, id, header.startedAt);
    let updatedAt = header.startedAt;
    const branchPending = new Map<string, boolean>();
    let sequentialPending = false;

    try {
      const { forEachJsonLine } = await import("./adapter.js");
      await forEachJsonLine(sourcePath, async (raw, lineNumber) => {
        const entry = raw && typeof raw === "object" ? raw as PiEntry : {};
        const entryId = stringOrUndefined(entry.id) ?? `line:${lineNumber}`;
        const parentId = stringOrUndefined(entry.parentId ?? undefined);
        const inheritedPending = parentId ? branchPending.get(parentId) ?? false : sequentialPending;
        let pending = inheritedPending;
        const timestamp = isoFromMilliseconds(entry.timestamp, header.startedAt);
        updatedAt = maxIso(updatedAt, timestamp);
        const type = stringOrUndefined(entry.type)?.toLowerCase() ?? "";
        if (isDerivedEntry(type)) {
          branchPending.set(entryId, pending);
          sequentialPending = pending;
          return;
        }
        if (type !== "message" || !entry.message || typeof entry.message !== "object") {
          branchPending.set(entryId, pending);
          sequentialPending = pending;
          return;
        }
        const role = stringOrUndefined(entry.message.role)?.toLowerCase();
        const content = entry.message.content;
        if (role === "user") {
          for (const text of textParts(content)) await addTextTurn(spool, "user", text, timestamp, entryId, parentId);
        } else if (role === "assistant") {
          const blocks = toolBlocks(content);
          const hasMemoryCall = hasToolCall(content);
          const provenance = pending ? "memory-assisted" as const : "original" as const;
          for (const text of textParts(content)) {
            await addTextTurn(spool, "assistant", text, timestamp, entryId, parentId, provenance);
          }
          for (const block of blocks) {
            await addTextTurn(spool, "action", actionText(block.name, block.input), timestamp, entryId, parentId);
          }
          if (pending && textParts(content).length > 0) pending = false;
          if (hasMemoryCall || blocks.some((block) => isMemorySearchToolName(block.name))) pending = true;
        } else if (role === "tool" || role === "toolresult" || role === "tool_result") {
          // Tool results are deliberately excluded, but branch state still passes through them.
        }
        branchPending.set(entryId, pending);
        sequentialPending = pending;
      });
      return await completeSession({ source: this.source, nativeSessionId: nativeId, sourceLocator: sourcePath, metadata, startedAt: header.startedAt, updatedAt, spool, options, classification: sessionClassification, sessionLabel: label });
    } catch (error) {
      await spool.cleanup().catch(() => undefined);
      throw error;
    }
  }
}
