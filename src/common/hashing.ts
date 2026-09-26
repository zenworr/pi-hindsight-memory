import crypto from "node:crypto";
import fs from "node:fs";
import { promisify } from "node:util";
import { READ_BUFFER_BYTES } from "./limits.js";

const read = promisify(fs.read);

const OPERATION_NAMESPACE = "7a4e0e80-f44d-4a23-a8a4-d884c6a7c35c";

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function sampleFileHash(filePath: string, sampleBytes = READ_BUFFER_BYTES): Promise<string> {
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
function uuidv5(name: string, namespace = OPERATION_NAMESPACE): string {
  const namespaceBytes = parseUuid(namespace);
  const digest = crypto.createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const layout = { bytes: 16, versionIndex: 6, versionMask: 0x0f, version: 0x50, variantIndex: 8, variantMask: 0x3f, variant: 0x80 };
  const bytes = Buffer.from(digest.subarray(0, layout.bytes));
  bytes[layout.versionIndex] = (bytes[layout.versionIndex]! & layout.versionMask) | layout.version;
  bytes[layout.variantIndex] = (bytes[layout.variantIndex]! & layout.variantMask) | layout.variant;
  return bytes.toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
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
