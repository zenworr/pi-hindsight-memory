import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";

test("HTTP retry attempts honor the configured limit", async () => {
  const config = { ...defaultConfig().hindsight, httpMaxAttempts: 2, httpRetryDelayMs: 1 };
  let calls = 0;
  const client = new HindsightClient(config, async () => { calls++; return new Response("{}", { status: 503 }); }, "test-token");
  await assert.rejects(client.health(), /HTTP 503/);
  assert.equal(calls, 2);
});

test("Retry-After is bounded by the configured delay cap and request deadline", async () => {
  const config = { ...defaultConfig().hindsight, requestTimeoutMs: 2000, httpRetryDelayMs: 1, httpMaxRetryDelayMs: 1 };
  let calls = 0;
  const client = new HindsightClient(config, async () => {
    calls++;
    return calls === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "120" } }) : Response.json({ status: "healthy" });
  }, "test-token");
  assert.deepEqual(await client.health(), { status: "healthy" });
  assert.equal(calls, 2);
});
