#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
npm run build >/dev/null
node --input-type=module <<'NODE'
import { loadConfig } from './dist/src/common/config.js';
import { HindsightClient } from './dist/src/hindsight/client.js';
import { operationIdFor, sha256 } from './dist/src/common/hashing.js';
const base = loadConfig();
const bank = `coding-history-contract-${Date.now().toString(36)}`;
const config = { ...base.hindsight, bankId: bank };
const client = new HindsightClient(config);
const documentId = `agent-session:contract:smoke`;
const manifest = { version: '1', bank: { retain_default_strategy: 'conversation', retain_strategies: { conversation: { retain_extraction_mode: 'chunks', retain_chunk_size: 12000 } }, enable_observations: false, enable_auto_consolidation: false } };
const session = (hash, content) => ({ source: 'pi', nativeSessionId: 'smoke', documentId, canonicalHash: hash, canonicalBytes: Buffer.byteLength(content), canonicalTurns: 2, sessionStartedAt: '2026-01-01T00:00:00.000Z', sessionUpdatedAt: '2026-01-01T00:01:00.000Z', metadata: { source: 'pi', native_session_id: 'smoke', source_path: '/synthetic/smoke', canonical_schema: 'agent-session-v1', adapter_version: '0.1.0', redaction_policy_version: '2' }, readContent: async () => content });
try {
  await client.ensureBank();
  await client.importBankTemplate(manifest);
  const first = session('contract-a', '{"role":"user","content":"Contract sentinel alpha","timestamp":"2026-01-01T00:00:00.000Z"}\n');
  const firstOp = operationIdFor(bank, documentId, first.canonicalHash);
  const submitted = await client.retainWithOperationId(first, firstOp);
  if (submitted.operation_id !== firstOp) throw new Error('server did not echo caller operation_id');
  const completed = await client.waitForOperation(firstOp, undefined, 120000);
  if (completed.status !== 'completed') throw new Error(`unexpected first status: ${completed.status}`);
  const recalled = await client.recall('Contract sentinel alpha');
  if (!recalled.results?.length) throw new Error('sentinel was not recalled');
  const second = session('contract-b', '{"role":"user","content":"Contract sentinel beta","timestamp":"2026-01-01T00:00:00.000Z"}\n');
  const secondOp = operationIdFor(bank, documentId, second.canonicalHash);
  await client.retainWithOperationId(second, secondOp);
  await client.waitForOperation(secondOp, undefined, 120000);
  await client.deleteDocument(documentId);
  await client.deleteBank();
  console.log(JSON.stringify({ ok: true, bank, firstOperation: firstOp, secondOperation: secondOp, recalled: recalled.results.length }));
} catch (error) {
  try { await client.deleteBank(); } catch { /* best effort cleanup */ }
  throw error;
}
NODE
