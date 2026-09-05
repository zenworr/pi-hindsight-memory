import fs from "node:fs";
import path from "node:path";
import { sampleFileHash, sha256, documentIdFor } from "../common/hashing.js";
import type { AdapterLoadOptions, CanonicalSession, CanonicalSessionMetadata, CanonicalTurn, SessionClassification, SessionReference, Source, SourceFingerprint } from "../common/types.js";
import { ADAPTER_VERSION, CANONICAL_SCHEMA, REDACTION_POLICY_VERSION } from "../common/types.js";
import { CanonicalSpool, finishCanonicalSession, normalizeText } from "../canonical/render.js";
import { stripHarnessContext, stripInjectedMemory } from "../canonical/injected-memory.js";

export interface SessionAdapter {
  readonly source: Source;
  discover(): AsyncIterable<SessionReference>;
  fingerprint(reference: SessionReference): Promise<SourceFingerprint>;
  classify(reference: SessionReference): Promise<SessionClassification>;
  load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession>;
}

export class MalformedJsonLineError extends Error {
  constructor(public readonly sourcePath: string, public readonly lineNumber: number, message: string) {
    super(`${sourcePath}:${lineNumber}: ${message}`);
    this.name = "MalformedJsonLineError";
  }
}

export interface JsonLineOptions {
  signal?: AbortSignal;
  maxLineBytes?: number;
  onIncompleteFinalLine?: (lineNumber: number) => void;
}

/** Stream JSON Lines without loading the source file into memory. An invalid final tail is treated as an active write; invalid newline-terminated lines fail closed. */
export async function forEachJsonLine(
  filePath: string,
  callback: (value: unknown, lineNumber: number) => Promise<void> | void,
  options: JsonLineOptions = {},
): Promise<void> {
  const maxLineBytes = options.maxLineBytes ?? 256 * 1024 * 1024;
  options.signal?.throwIfAborted();
  const input = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024, signal: options.signal });
  let buffer = "";
  let lineNumber = 0;
  try {
    for await (const chunk of input) {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        options.signal?.throwIfAborted();
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        lineNumber += 1;
        if (Buffer.byteLength(line, "utf8") > maxLineBytes) throw new MalformedJsonLineError(filePath, lineNumber, `JSON line exceeds ${maxLineBytes} bytes`);
        if (line.trim()) {
          try { await callback(JSON.parse(line), lineNumber); }
          catch (error) {
            if (error instanceof MalformedJsonLineError) throw error;
            if (error instanceof SyntaxError) throw new MalformedJsonLineError(filePath, lineNumber, "Malformed JSON record");
            throw error;
          }
        }
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new MalformedJsonLineError(filePath, lineNumber + 1, `JSON line exceeds ${maxLineBytes} bytes`);
    }
    if (buffer.trim()) {
      lineNumber += 1;
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) throw new MalformedJsonLineError(filePath, lineNumber, `JSON line exceeds ${maxLineBytes} bytes`);
      // A JSON Lines record is complete only after its newline. The writer may have stopped
      // between bytes, and even valid JSON here must wait for the next scan.
      options.onIncompleteFinalLine?.(lineNumber);
    }
  } finally { input.destroy(); }
}

export async function firstJsonLine(filePath: string): Promise<unknown | undefined> {
  const input = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let buffer = "";
  try {
    for await (const chunk of input) {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(buffer, "utf8") > 256 * 1024 * 1024) throw new MalformedJsonLineError(filePath, 1, "first JSON line is too large");
        continue;
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      if (!line.trim()) { buffer = buffer.slice(newline + 1); continue; }
      try { return JSON.parse(line); }
      catch { throw new MalformedJsonLineError(filePath, 1, "Malformed JSON header"); }
    }
    // A header without a terminating newline is also provisional. The next scan will read it
    // after the writer completes the record.
    return undefined;
  } finally { input.destroy(); }
}

export async function walkFiles(root: string, extension = ".jsonl"): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) output.push(full);
    }
  }
  await visit(root);
  return output;
}

export async function pathFingerprint(filePath: string, stableLocator: string): Promise<SourceFingerprint> {
  const stat = await fs.promises.stat(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, sampleHash: await sampleFileHash(filePath), stableLocator };
}

export function isoFromMilliseconds(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

export function maxIso(current: string, candidate: string): string {
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export function stableFallbackId(source: Source, identityKey: string, startedAt: string): string {
  return `fallback-${sha256(`${source}\n${identityKey}\n${startedAt}`).slice(0, 32)}`;
}

export function metadataBase(source: Source, nativeSessionId: string, sourcePath: string): CanonicalSessionMetadata {
  return {
    source,
    native_session_id: nativeSessionId,
    source_path: sourcePath,
    canonical_schema: CANONICAL_SCHEMA,
    adapter_version: ADAPTER_VERSION,
    redaction_policy_version: REDACTION_POLICY_VERSION,
  };
}

export async function createSpool(options: AdapterLoadOptions, documentId: string, startedAt: string): Promise<CanonicalSpool> {
  return CanonicalSpool.create(options.spoolDirectory, documentId, startedAt, options.maxCanonicalBytes);
}

export async function completeSession(args: {
  source: Source;
  nativeSessionId: string;
  sourceLocator: string;
  metadata: CanonicalSessionMetadata;
  startedAt: string;
  updatedAt: string;
  spool: CanonicalSpool;
  options: AdapterLoadOptions;
  classification?: SessionClassification;
  sessionLabel?: string;
}): Promise<CanonicalSession> {
  return finishCanonicalSession({
    source: args.source,
    nativeSessionId: args.nativeSessionId,
    sourceLocator: args.sourceLocator,
    metadata: args.metadata,
    sessionStartedAt: args.startedAt,
    sessionUpdatedAt: args.updatedAt,
    spool: args.spool,
    maxCanonicalBytes: args.options.maxCanonicalBytes,
    classification: args.classification,
    sessionLabel: args.sessionLabel,
  });
}

export async function addTextTurn(
  spool: CanonicalSpool,
  role: "user" | "assistant" | "action",
  content: unknown,
  timestamp: string,
  nativeEntryId?: string,
  parentEntryId?: string,
  provenance?: "original" | "memory-assisted",
): Promise<boolean> {
  if (typeof content !== "string") return false;
  const normalized = normalizeText(content);
  const text = stripInjectedMemory(role === "user" ? stripHarnessContext(normalized) : normalized);
  if (!text) return false;
  const turn: CanonicalTurn = { role, content: text, timestamp };
  if (nativeEntryId !== undefined) turn.native_entry_id = nativeEntryId;
  if (parentEntryId !== undefined) turn.parent_entry_id = parentEntryId;
  if (provenance !== undefined) turn.provenance = provenance;
  await spool.add(turn);
  return true;
}

export function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const result: string[] = [];
  for (const block of content) {
    if (typeof block === "string") { if (block.trim()) result.push(block); continue; }
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (["text", "input_text", "output_text", "markdown"].includes(type) && typeof item.text === "string" && item.text.trim()) result.push(item.text);
  }
  return result;
}

export function hasToolCall(content: unknown, names: string[] = ["memory_search"]): boolean {
  if (!Array.isArray(content)) return false;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const item = block as Record<string, unknown>;
    const name = item.name ?? item.toolName ?? item.tool_name ?? (item.function && typeof item.function === "object" ? (item.function as Record<string, unknown>).name : undefined);
    return typeof name === "string" && wanted.has(name.toLowerCase());
  });
}

export function toolBlocks(content: unknown): Array<{ name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const output: Array<{ name: string; input: unknown }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (!type.toLowerCase().includes("tool") && !type.toLowerCase().includes("function")) continue;
    const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : undefined;
    const name = item.name ?? item.toolName ?? item.tool_name ?? fn?.name;
    if (typeof name !== "string") continue;
    let input = item.input ?? item.arguments ?? item.parameters ?? fn?.arguments;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* keep compact raw input */ } }
    output.push({ name, input });
  }
  return output;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function documentId(source: Source, id: string): string { return documentIdFor(source, id); }
