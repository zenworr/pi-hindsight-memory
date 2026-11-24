#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
npm run build >/dev/null
node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto';
import { loadConfig } from './dist/src/common/config.js';
import { HindsightClient } from './dist/src/hindsight/client.js';
import { operationIdFor, sha256 } from './dist/src/common/hashing.js';
const base = loadConfig();
const bank = `coding-history-contract-${randomUUID()}`;
const config = { ...base.hindsight, bankId: bank };
const client = new HindsightClient(config);
const documentId = `agent-session:contract:smoke`;
const manifest = { version: '1', bank: { retain_default_strategy: 'conversation', retain_strategies: { conversation: { retain_extraction_mode: 'chunks', retain_chunk_size: 12000 } }, store_document_text: true, enable_observations: false, enable_auto_consolidation: false } };
const timestamp = '2026-01-01T00:00:00.000Z';
const session = (text) => {
  const content = `${JSON.stringify({ role: 'user', content: text, timestamp })}\n`;
  return { source: 'pi', nativeSessionId: 'smoke', documentId, canonicalHash: sha256(content), canonicalBytes: Buffer.byteLength(content), canonicalTurns: 1, sessionStartedAt: timestamp, sessionUpdatedAt: timestamp, metadata: { source: 'pi', native_session_id: 'smoke', source_path: '/synthetic/smoke', canonical_schema: 'agent-session-v1', adapter_version: '0.1.0', redaction_policy_version: '2' }, readContent: async () => content };
};
async function retain(text) {
  const current = session(text);
  const operationId = operationIdFor(bank, documentId, current.canonicalHash);
  const submitted = await client.retainWithOperationId(current, operationId);
  if (submitted.operation_id !== operationId) throw new Error('server did not echo caller operation_id');
  await client.waitForOperation(operationId, undefined, 120000);
  if ((await client.getDocument(documentId))?.content_hash !== current.canonicalHash) throw new Error('stored document hash does not match the retained content');
  return operationId;
}
try {
  await client.ensureBank();
  await client.importBankTemplate(manifest);
  const { config: applied } = await client.getBankConfig();
  if (applied?.retain_strategies?.conversation?.retain_extraction_mode !== 'chunks') throw new Error('disposable bank is not configured for chunk-only retain');
  const sentinel = 'Contract sentinel alpha';
  const firstOp = await retain(sentinel);
  const recalled = await client.recall(sentinel);
  if (!recalled.results?.some(result => result.text?.includes(sentinel))) throw new Error('sentinel was not recalled');
  const secondOp = await retain('Contract sentinel beta');
  await client.deleteDocument(documentId);
  if (await client.getDocument(documentId)) throw new Error('synthetic document was not deleted');
  await client.deleteBank();
  console.log(JSON.stringify({ ok: true, bank, firstOperation: firstOp, secondOperation: secondOp, recalled: recalled.results.length }));
} catch (error) {
  try { await client.deleteBank(); } catch { console.error(`Could not confirm removal of disposable bank ${bank}`); }
  throw error;
}
NODE
