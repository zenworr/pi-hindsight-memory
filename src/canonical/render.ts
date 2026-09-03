import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { CanonicalSession, CanonicalSessionMetadata, CanonicalTurn, SessionClassification, Source } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
import { redactTurn } from "./redact.js";

const DEFAULT_MAX_CANONICAL_BYTES = 100 * 1024 * 1024;

export function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

export function serializeTurn(turn: CanonicalTurn): string {
  const normalized: Record<string, unknown> = {
    role: turn.role,
    content: normalizeText(turn.content),
    timestamp: turn.timestamp,
  };
  if (turn.native_entry_id !== undefined) normalized.native_entry_id = turn.native_entry_id;
  if (turn.parent_entry_id !== undefined) normalized.parent_entry_id = turn.parent_entry_id;
  if (turn.provenance !== undefined) normalized.provenance = turn.provenance;
  return JSON.stringify(normalized);
}

export class CanonicalSpool {
  readonly path: string;
  private readonly stream: fs.WriteStream;
  private readonly hash = crypto.createHash("sha256");
  private bytes = 0;
  private turns = 0;
  private redactions = 0;
  private finalized = false;
  private writeError: Error | undefined;

  private constructor(spoolPath: string, private readonly maxBytes = Number.POSITIVE_INFINITY) {
    this.path = spoolPath;
    this.stream = fs.createWriteStream(spoolPath, { flags: "wx", mode: 0o600 });
    this.stream.on("error", (error) => { this.writeError = error; });
  }

  static async create(directory: string, documentId: string, timestamp: string, maxBytes = Number.POSITIVE_INFINITY): Promise<CanonicalSpool> {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${randomUUID()}.jsonl`);
    const spool = new CanonicalSpool(file, maxBytes);
    await spool.add({ role: "system", content: `REF-ID: ${documentId}`, timestamp });
    return spool;
  }

  async add(turn: CanonicalTurn): Promise<void> {
    if (this.finalized) throw new Error("Cannot add a turn after canonical spool finalization");
    if (this.writeError) throw this.writeError;
    const redacted = redactTurn({ ...turn, content: normalizeText(turn.content) });
    this.redactions += redacted.count;
    const line = `${serializeTurn(redacted.turn)}\n`;
    const buffer = Buffer.from(line, "utf8");
    if (this.bytes + buffer.byteLength > this.maxBytes) {
      throw new Error(`Canonical document exceeds configured limit of ${this.maxBytes} bytes`);
    }
    this.hash.update(buffer);
    this.bytes += buffer.byteLength;
    this.turns += 1;
    if (!this.stream.write(buffer)) await once(this.stream, "drain");
    if (this.writeError) throw this.writeError;
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.stream.end();
    await once(this.stream, "close");
    if (this.writeError) throw this.writeError;
  }

  get stats() { return { hash: this.hash.copy().digest("hex"), bytes: this.bytes, turns: this.turns, redactions: this.redactions }; }

  async cleanup(): Promise<void> { await fs.promises.rm(this.path, { force: true }); }
}

export async function finishCanonicalSession(args: {
  source: Source;
  nativeSessionId: string;
  sourceLocator: string;
  metadata: CanonicalSessionMetadata;
  sessionStartedAt: string;
  sessionUpdatedAt: string;
  spool: CanonicalSpool;
  maxCanonicalBytes?: number;
  classification?: SessionClassification;
  sessionLabel?: string;
}): Promise<CanonicalSession> {
  await args.spool.finalize();
  const stats = args.spool.stats;
  const maxBytes = args.maxCanonicalBytes ?? DEFAULT_MAX_CANONICAL_BYTES;
  const emptyAfterNormalization = stats.turns <= 1;
  const session: CanonicalSession = {
    source: args.source,
    nativeSessionId: args.nativeSessionId,
    documentId: documentIdFor(args.source, args.nativeSessionId),
    sourceLocator: args.sourceLocator,
    metadata: args.metadata,
    sessionStartedAt: args.sessionStartedAt,
    sessionUpdatedAt: args.sessionUpdatedAt,
    canonicalHash: stats.hash,
    canonicalBytes: stats.bytes,
    canonicalTurns: stats.turns,
    redactionCount: stats.redactions,
    emptyAfterNormalization,
    classification: args.classification,
    sessionLabel: args.sessionLabel,
    contentPath: args.spool.path,
    async readContent(limit = maxBytes) {
      if (stats.bytes > limit) throw new Error(`Canonical document is ${stats.bytes} bytes; configured limit is ${limit} bytes`);
      return fs.promises.readFile(args.spool.path, "utf8");
    },
    async cleanup() {
      await fs.promises.rm(args.spool.path, { force: true });
    },
  };
  return session;
}
