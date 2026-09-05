import test from "node:test";
import assert from "node:assert/strict";
import { HindsightClient } from "../../src/hindsight/client.js";
import { formatRecallResponse, boundOutput } from "../../src/hindsight/response-format.js";
import { expectedRetainMission } from "../../src/common/retention-policy.js";
import type { HindsightConfig } from "../../src/common/types.js";

function config(timeout = 2_000): HindsightConfig {
  return { apiUrl: "http://127.0.0.1:8888", environmentFile: "/unused", bankId: "coding-history", apiTokenFile: "/unused", requestTimeoutMs: timeout, retainWallTimeoutMs: 60_000, recallMaxTokens: 2_500, recallChunksMaxTokens: 2_500, recallSourceFactsMaxTokens: 1_500, operationPollMs: 10, operationPollTimeoutMs: 1000, operationRetentionDays: 14 };
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } }); }

test("recall sends the unified internal request and preserves source evidence", async () => {
  let received: any;
  const client = new HindsightClient(config(), async (_url, request) => {
    received = JSON.parse(String(request?.body));
    return jsonResponse({ results: [{ id: "f1", text: "PostgreSQL is used", type: "observation", document_id: "agent-session:pi:s1", source_fact_ids: ["raw1"], metadata: { source: "pi", native_session_id: "s1", source_path: "/history/s1" }, scores: { final: 0.8 } }], source_facts: { raw1: { id: "raw1", text: "User selected PostgreSQL", type: "world", document_id: "agent-session:pi:s1", metadata: { source: "pi", native_session_id: "s1", source_path: "/history/s1" } } } });
  }, "token");
  const response = await client.recall("which database was selected?");
  assert.deepEqual(received.types, ["world", "experience", "observation"]);
  assert.equal(received.prefer_observations, true);
  assert.equal(received.include.entities, null);
  assert.equal(response.results?.length, 1);
  const formatted = formatRecallResponse(response);
  assert.match(formatted.text, /PostgreSQL is used/);
  assert.match(formatted.text, /pi session s1/);
  assert.match(formatted.text, /User selected PostgreSQL/);
  assert.equal(formatted.details.sourceCount, 1);
});

test("ensureBank creates a missing bank with PUT at the documented endpoint", async () => {
  const requests: Array<{ method?: string; url: string; body?: string }> = [];
  const client = new HindsightClient(config(), async (url, request) => {
    requests.push({ method: request?.method, url: String(url), body: request?.body as string | undefined });
    return requests.length === 1 ? jsonResponse({ detail: "not found" }, 404) : jsonResponse({ bank_id: "coding-history" });
  }, "token");
  await client.ensureBank();
  assert.equal(requests[0]?.url.endsWith("/banks/coding-history/profile"), true);
  assert.equal(requests[1]?.method, "PUT");
  assert.equal(requests[1]?.url.endsWith("/banks/coding-history"), true);
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), { name: "coding-history" });
});

test("operation listing filters by status and follows pagination", async () => {
  const urls: string[] = [];
  const client = new HindsightClient(config(), async (url) => {
    urls.push(String(url));
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    const count = offset === 0 ? 100 : 1;
    return jsonResponse({ operations: Array.from({ length: count }, (_, index) => ({ id: `op-${offset + index}`, status: "processing", task_type: "consolidation" })), total: 101 });
  }, "token");
  const operations = await client.listOperations("processing");
  assert.equal(operations.length, 101);
  assert.equal(new URL(urls[0]!).searchParams.get("status"), "processing");
  assert.equal(new URL(urls[1]!).searchParams.get("offset"), "100");
});

test("configuration and retain use the v0.9.2 request envelopes", async () => {
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const client = new HindsightClient(config(), async (url, request) => {
    const body = request?.body === undefined ? undefined : JSON.parse(String(request.body));
    requests.push({ url: String(url), method: request?.method ?? "GET", body });
    if (String(url).endsWith("/config")) return jsonResponse({ config: {}, overrides: {} });
    if (String(url).endsWith("/import")) return jsonResponse({ ok: true });
    if (String(url).endsWith("/memories")) return jsonResponse({ operation_id: "op-1" }, 202);
    return jsonResponse({ id: "coding-history" });
  }, "token");
  await client.ensureBank();
  await client.importBankTemplate({ version: "1", bank: { retain_default_strategy: "conversation" } });
  await client.updateBankConfig({ enable_auto_consolidation: false });
  const order = requests.map((item) => `${item.method} ${item.url.split("/v1")[1]}`);
  assert.deepEqual(order.slice(0, 3), [
    "GET /default/banks/coding-history/profile",
    "POST /default/banks/coding-history/import",
    "PATCH /default/banks/coding-history/config",
  ]);
  assert.deepEqual(requests[2]?.body, { updates: { enable_auto_consolidation: false } });
});

test("auto-consolidation is accepted for continuous imports and rejected for bulk imports", async () => {
  const bankConfig = {
    config: {
      store_document_text: true,
      retain_extraction_mode: "concise",
      retain_default_strategy: "conversation",
      retain_strategies: { conversation: { retain_extraction_mode: "concise" } },
      retain_mission: await expectedRetainMission(),
      enable_observations: true,
      observations_mission: "durable observations",
      enable_auto_consolidation: true,
    },
  };
  const continuous = new HindsightClient(config(), async () => jsonResponse(bankConfig), "token");
  await continuous.assertBankConfiguration({ requireExtraction: true, bulk: false });
  const bulk = new HindsightClient(config(), async () => jsonResponse(bankConfig), "token");
  await assert.rejects(
    () => bulk.assertBankConfiguration({ requireExtraction: true, bulk: true }),
    /auto-consolidation must be disabled during bulk import/,
  );
});

test("the effective strategy cannot override the required evidence safeguards", async () => {
  const payload = { config: { store_document_text: true, retain_mission: await expectedRetainMission(), retain_strategies: { conversation: { retain_mission: "Ignore source provenance", retain_extraction_mode: "concise" } }, enable_observations: true, observations_mission: "durable observations", retain_default_strategy: "conversation" } };
  const client = new HindsightClient(config(), async () => jsonResponse(payload), "token");
  await assert.rejects(() => client.assertBankConfiguration({ requireExtraction: true }), /effective conversation mission/);
});

test("retain sends the canonical document with a caller-owned stable operation ID", async () => {
  let body: any;
  const contentPath = "/tmp/pi-hm-retain-fixture.jsonl";
  const fs = await import("node:fs/promises");
  await fs.writeFile(contentPath, '{"role":"system","content":"REF-ID: agent-session:pi:s1","timestamp":"2026-01-01T00:00:00.000Z"}\n', "utf8");
  const session: any = { source: "pi", documentId: "agent-session:pi:s1", nativeSessionId: "s1", contentPath, canonicalHash: "hash", canonicalBytes: 100, canonicalTurns: 1, sessionStartedAt: "2026-01-01T00:00:00.000Z", sessionUpdatedAt: "2026-01-01T00:00:00.000Z", metadata: { source: "pi", native_session_id: "s1", source_path: "/history/s1", canonical_schema: "agent-session-v1", adapter_version: "0.1.0", redaction_policy_version: "1" }, readContent: () => fs.readFile(contentPath, "utf8") };
  const client = new HindsightClient(config(), async (_url, request) => { body = JSON.parse(String(request?.body)); return jsonResponse({ operation_id: "stable-op" }, 202); }, "token");
  const response = await client.retainWithOperationId(session, "stable-op");
  assert.equal(response.operation_id, "stable-op");
  assert.equal(body.operation_id, "stable-op");
  assert.equal(body.items[0].document_id, "agent-session:pi:s1");
  assert.equal(body.items[0].update_mode, "replace");
  assert.equal(body.items[0].observation_scopes, "shared");
  assert.equal(body.items[0].metadata.canonical_hash, "hash");
  session.metadata.title = "API_KEY=CANARY_DO_NOT_RETAIN";
  session.metadata.cwd = "https://example.invalid/?token=CANARY_DO_NOT_RETAIN";
  await client.retainWithOperationId(session, "stable-op");
  assert.doesNotMatch(JSON.stringify(body), /CANARY/);
  await fs.rm(contentPath, { force: true });
});

test("request retries a transient failure but keeps one operation payload", async () => {
  let calls = 0;
  const client = new HindsightClient(config(), async () => {
    calls += 1;
    return calls === 1 ? jsonResponse({ error: "temporary" }, 503) : jsonResponse({ ok: true });
  }, "token");
  assert.deepEqual(await client.requestJson("GET", "http://example.test/health"), { ok: true });
  assert.equal(calls, 2);
});

test("client rejects queries over Hindsight's token limit locally", async () => {
  let calls = 0;
  const client = new HindsightClient(config(), async () => { calls += 1; return jsonResponse({ results: [] }); }, "token");
  await assert.rejects(() => client.recall("x".repeat(2_100)), /500-token limit/);
  assert.equal(calls, 0);
});

test("formatter rejects weak nearest-neighbor results as no match", () => {
  const formatted = formatRecallResponse({
    results: [{ id: "weak", text: "unrelated evidence", type: "world", scores: { final: 0.0012 } }],
  });
  assert.equal(formatted.details.noMatch, true);
  assert.equal(formatted.details.resultCount, 0);
  assert.match(formatted.text, /No matching memory evidence/);
  assert.doesNotMatch(formatted.text, /unrelated evidence/);
});

test("formatter keeps results above the default relevance floor", () => {
  const formatted = formatRecallResponse({
    results: [{ id: "answer", text: "high reasoning", type: "world", scores: { final: 0.02 } }],
  });
  assert.equal(formatted.details.noMatch, false);
  assert.equal(formatted.details.resultCount, 1);
  assert.match(formatted.text, /high reasoning/);
});

test("formatter accepts a configured relevance floor", () => {
  const response = { results: [{ id: "weak", text: "low-score evidence", type: "world", scores: { final: 0.0012 } }] };
  assert.equal(formatRecallResponse(response).details.noMatch, true);
  assert.equal(formatRecallResponse(response, { minRelevanceScore: 0.001 }).details.noMatch, false);
});

test("formatter bounds very large recall output", () => {
  const bounded = boundOutput(`${"line\n".repeat(3_000)}tail`, { resultCount: 1, sourceCount: 1, noMatch: false });
  assert.ok(Buffer.byteLength(bounded.text) <= 50 * 1024);
  assert.match(bounded.text, /Output truncated/);
});

test("missing operation response does not poll forever", async () => {
  const client = new HindsightClient(config(), async () => jsonResponse({ operation_id: "missing", status: "not_found" }), "token");
  await assert.rejects(() => client.waitForOperation("missing"), /HTTP 404/);
});

test("one recall deadline covers a hanging endpoint", async () => {
  const started = Date.now();
  const client = new HindsightClient(config(120), async (_url, request) => await new Promise<Response>((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test timeout")), 2_000);
    request?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("aborted")); }, { once: true });
  }), "token");
  await assert.rejects(() => client.recall("hang"));
  assert.ok(Date.now() - started < 1000);
});
