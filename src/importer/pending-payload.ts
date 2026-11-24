import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { PRIVATE_FILE_MODE } from "../common/limits.js";
import type { CanonicalSession } from "../common/types.js";
import { REDACTION_POLICY_VERSION } from "../common/types.js";

type PayloadMetadata = Omit<CanonicalSession, "readContent" | "cleanup" | "contentPath">;

export const STALE_REDACTION_PAYLOAD = "Pending payload uses an unsupported redaction policy; reconcile it before retrying";
export class StaleRedactionPayloadError extends Error {
  constructor() { super(STALE_REDACTION_PAYLOAD); }
}

export class PendingPayloadIntegrityError extends Error {
  constructor(message: string) { super(`Local payload integrity failure: ${message}`); }
}

function paths(directory: string, operationId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(operationId)) throw new Error("Invalid pending operation identifier");
  const root = path.join(directory, "pending");
  return { root, text: path.join(root, `${operationId}.jsonl`), metadata: path.join(root, `${operationId}.json`) };
}

export async function savePendingPayload(directory: string, operationId: string, session: CanonicalSession): Promise<void> {
  const files = paths(directory, operationId);
  await fs.mkdir(files.root, { recursive: true, mode: 0o700 });
  const metadata = { ...session, readContent: undefined, cleanup: undefined, contentPath: undefined };
  const temporaryText = `${files.text}.tmp`;
  await fs.copyFile(session.contentPath, temporaryText);
  await fs.chmod(temporaryText, PRIVATE_FILE_MODE);
  const text = await fs.open(temporaryText, "r");
  try { await text.sync(); } finally { await text.close(); }
  await fs.rename(temporaryText, files.text);
  const temporary = `${files.metadata}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
  const handle = await fs.open(temporary, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, files.metadata);
  const directoryHandle = await fs.open(files.root, "r");
  try { await directoryHandle.sync(); }
  catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  finally { await directoryHandle.close(); }
}

export async function loadPendingPayload(directory: string, operationId: string, expectedHash: string): Promise<CanonicalSession | undefined> {
  const files = paths(directory, operationId);
  let metadata: PayloadMetadata | null;
  try { metadata = JSON.parse(await fs.readFile(files.metadata, "utf8")) as PayloadMetadata | null; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new PendingPayloadIntegrityError("Pending payload metadata is invalid");
    throw error;
  }
  if (!metadata?.metadata) throw new PendingPayloadIntegrityError("Pending payload metadata is invalid");
  if (metadata.metadata.redaction_policy_version !== REDACTION_POLICY_VERSION) throw new StaleRedactionPayloadError();
  const hash = createHash("sha256");
  try { for await (const chunk of createReadStream(files.text)) hash.update(chunk as Buffer); }
  catch (error) { throw pendingReadError(error); }
  if (metadata.canonicalHash !== expectedHash || hash.digest("hex") !== expectedHash) throw new PendingPayloadIntegrityError("Pending payload hash does not match the generation");
  return {
    ...metadata,
    contentPath: files.text,
    async readContent(maxBytes = metadata.canonicalBytes) {
      try {
        if ((await fs.stat(files.text)).size > maxBytes) throw new PendingPayloadIntegrityError("Pending payload exceeds the request limit");
        const bytes = await fs.readFile(files.text);
        if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new PendingPayloadIntegrityError("Pending payload hash does not match the generation");
        return bytes.toString("utf8");
      } catch (error) { throw pendingReadError(error); }
    },
    cleanup() { return Promise.resolve(); },
  };
}

function pendingReadError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EISDIR" ? new PendingPayloadIntegrityError("Pending payload content is missing or invalid") : error;
}

export async function removePendingPayload(directory: string, operationId: string): Promise<void> {
  const files = paths(directory, operationId);
  await Promise.all([fs.rm(files.text, { force: true }), fs.rm(files.metadata, { force: true })]);
}
