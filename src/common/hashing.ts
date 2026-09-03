import crypto from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";

const read = promisify(fs.read);

export const OPERATION_NAMESPACE = "7a4e0e80-f44d-4a23-a8a4-d884c6a7c35c";

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function sampleFileHash(filePath: string, sampleBytes = 64 * 1024): Promise<string> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const firstLength = Math.min(sampleBytes, stat.size);
    const first = Buffer.alloc(firstLength);
    if (firstLength > 0) await read(handle.fd, first, 0, firstLength, 0);
    const lastLength = Math.min(sampleBytes, stat.size);
    const last = Buffer.alloc(lastLength);
    if (lastLength > 0) await read(handle.fd, last, 0, lastLength, Math.max(0, stat.size - lastLength));
    return sha256(Buffer.concat([first, last, Buffer.from(String(stat.size))]));
  } finally {
    await handle.close();
  }
}

function parseUuid(value: string): Buffer {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) throw new Error(`Invalid UUID: ${value}`);
  return Buffer.from(compact, "hex");
}

/** RFC 9562 UUIDv5 using the fixed namespace above. */
export function uuidv5(name: string, namespace = OPERATION_NAMESPACE): string {
  const namespaceBytes = parseUuid(namespace);
  const digest = crypto.createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function operationIdFor(bankId: string, documentId: string, canonicalHash: string): string {
  return uuidv5([
    "pi-hindsight-memory-operation-v1",
    bankId,
    documentId,
    canonicalHash,
  ].join("\n"));
}

export function replayOperationIdFor(bankId: string, documentId: string, canonicalHash: string, replay: number): string {
  if (!Number.isInteger(replay) || replay <= 0) throw new Error("replay must be a positive integer");
  return uuidv5([
    "pi-hindsight-memory-operation-replay-v1",
    bankId,
    documentId,
    canonicalHash,
    String(replay),
  ].join("\n"));
}

export function documentIdFor(source: string, nativeSessionId: string): string {
  return `agent-session:${source}:${nativeSessionId}`;
}
