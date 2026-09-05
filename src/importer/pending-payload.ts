import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { CanonicalSession } from "../common/types.js";

type PayloadMetadata = Omit<CanonicalSession, "readContent" | "cleanup" | "contentPath">;

function paths(directory: string, operationId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(operationId)) throw new Error("Invalid pending operation identifier");
  const root = path.join(directory, "pending");
  return { root, text: path.join(root, `${operationId}.jsonl`), metadata: path.join(root, `${operationId}.json`) };
}

export async function savePendingPayload(directory: string, operationId: string, session: CanonicalSession): Promise<void> {
  const files = paths(directory, operationId);
  await fs.mkdir(files.root, { recursive: true, mode: 0o700 });
  const { readContent: _read, cleanup: _cleanup, contentPath: _path, ...metadata } = session;
  const temporaryText = `${files.text}.tmp`;
  await fs.copyFile(session.contentPath, temporaryText);
  await fs.chmod(temporaryText, 0o600);
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
  let metadata: PayloadMetadata;
  try { metadata = JSON.parse(await fs.readFile(files.metadata, "utf8")) as PayloadMetadata; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(files.text)) hash.update(chunk);
  if (metadata.canonicalHash !== expectedHash || hash.digest("hex") !== expectedHash) throw new Error("Pending payload hash does not match the submitted generation");
  return {
    ...metadata,
    contentPath: files.text,
    async readContent(maxBytes = metadata.canonicalBytes) {
      if ((await fs.stat(files.text)).size > maxBytes) throw new Error("Pending payload exceeds the request limit");
      return fs.readFile(files.text, "utf8");
    },
    async cleanup() {},
  };
}

export async function removePendingPayload(directory: string, operationId: string): Promise<void> {
  const files = paths(directory, operationId);
  await Promise.all([fs.rm(files.text, { force: true }), fs.rm(files.metadata, { force: true })]);
}
