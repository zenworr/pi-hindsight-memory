import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CanonicalSpool, normalizeText } from "../../src/canonical/render.js";
import { redactText } from "../../src/canonical/redact.js";
import { actionText } from "../../src/canonical/actions.js";
import { sha256 } from "../../src/common/hashing.js";

async function tempDirectory(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-canonical-")); }

test("canonical rendering is deterministic and uses fixed field order", async () => {
  const directory = await tempDirectory();
  const render = async () => {
    const spool = await CanonicalSpool.create(directory, "agent-session:pi:test", "2026-01-01T00:00:00.000Z", 1_000_000);
    await spool.add({ role: "user", content: "  hello\r\nworld  ", timestamp: "2026-01-01T00:01:00.000Z", native_entry_id: "u1", parent_entry_id: "s1", provenance: "original" });
    await spool.finalize();
    const text = await fs.readFile(spool.path, "utf8");
    await spool.cleanup();
    return text;
  };
  const first = await render();
  const second = await render();
  assert.equal(first, second);
  assert.match(first, /^{"role":"system","content":"REF-ID: agent-session:pi:test","timestamp":/);
  assert.match(first, /"native_entry_id":"u1","parent_entry_id":"s1","provenance":"original"/);
  assert.equal(normalizeText(" a\r\nb "), "a\nb");
  await fs.rm(directory, { recursive: true, force: true });
});

test("canonical spool enforces the size limit before writing an oversized turn", async () => {
  const directory = await tempDirectory();
  const spool = await CanonicalSpool.create(directory, "agent-session:pi:test", "2026-01-01T00:00:00.000Z", 100);
  await assert.rejects(() => spool.add({ role: "user", content: "x".repeat(500), timestamp: "2026-01-01T00:00:00.000Z" }), /exceeds configured limit/);
  await spool.cleanup();
  await fs.rm(directory, { recursive: true, force: true });
});

test("redaction removes common credential forms without changing source text", () => {
  const openAiKey = `sk-${"abcdefghijklmnopqrstuvwxyz"}`;
  const awsKey = `AKIA${"1234567890ABCDEF"}`;
  const input = [
    `OPENAI_API_KEY=${openAiKey}`,
    "Authorization: Bearer abcdefghijklmnop1234",
    "postgresql://alice:password@localhost/db",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    awsKey,
    "{\"api_key\":\"json-secret-value\", \"nested\": true}",
    "https://example.test/callback?token=query-secret&x=1",
    "password: yaml-secret",
  ].join("\n");
  const result = redactText(input);
  assert.ok(result.count >= 5);
  for (const secret of ["alice:password@", "BEGIN PRIVATE KEY", awsKey, openAiKey, "json-secret-value", "query-secret", "yaml-secret"]) assert.equal(result.text.includes(secret), false);
  assert.match(result.text, /REDACTED/);
  assert.match(input, /password/);
});

test("actions are compact, bounded, and redacted", () => {
  const action = actionText("bash", { command: `echo sk-${"abcdefghijklmnopqrstuvwxyz"}` });
  assert.match(action, /^Run /);
  assert.doesNotMatch(action, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.ok(Buffer.byteLength(action, "utf8") <= 800);
});

test("common shell, JSON, and signed URL secrets are removed before actions leave the host", () => {
  const examples = [
    "export DATABASE_PASSWORD=CANARY_DO_NOT_RETAIN",
    "API_KEY=CANARY_DO_NOT_RETAIN",
    "DATABASE_PASSWORD=\"firstpart CANARY_DO_NOT_RETAIN\"",
    JSON.stringify({ password: 'firstpart"CANARY_DO_NOT_RETAIN' }),
    JSON.stringify({ dbPassword: "CANARY_DO_NOT_RETAIN" }),
    "https://example.invalid/path?X-Amz-Signature=CANARY_DO_NOT_RETAIN",
    "https://example.invalid/path?X-Goog-Signature=CANARY_DO_NOT_RETAIN",
    "Bearer CANARY123",
    "command; TOKEN=CANARY_DO_NOT_RETAIN other-command",
    "{\"password\":\"CANARY_DO_NOT_RETAIN\",\"key\":\"ordinary\"}",
  ];
  for (const text of examples) {
    const redacted = redactText(text).text;
    assert.doesNotMatch(redacted, /CANARY/, text);
    assert.doesNotMatch(actionText("bash", { command: text }), /CANARY/, text);
    assert.equal(redactText(redacted).text, redacted, "redaction is idempotent");
  }
  assert.equal(redactText("token count: 120; password policy: strong; normal=value").text, "token count: 120; password policy: strong; normal=value");
});

test("credential markers only exempt a complete value, including in shell assignments and URL parameters", () => {
  const inputs = [
    'TOKEN="[REDACTED:SECRET]CANARY"',
    'TOKEN="[REDACTED:SECRET]"CANARY',
    "TOKEN=before[REDACTED:SECRET]CANARY",
    "TOKEN=[REDACTED:SECRET][CANARY]",
    "TOKEN=[REDACTED:SECRET]]CANARY",
    "Authorization: Bearer [REDACTED:AUTH_TOKEN]CANARY",
    "https://example.invalid/?token=[REDACTED:URL_SECRET]CANARY",
    "https://example.invalid/?id_token=CANARY",
    "https://example.invalid/auth/callback?code=[REDACTED:OAUTH_CODE]CANARY&state=ok",
    "http://localhost/?code=CANARY&state=ok",
    "https://example.invalid/callback?code=CANARY",
    '{"id_token":"test-CANARY","client_secret":"[REDACTED:SECRET]CANARY"}',
  ];
  for (const input of inputs) {
    const result = redactText(input);
    assert.doesNotMatch(result.text, /CANARY/, input);
    assert.deepEqual(redactText(result.text), { text: result.text, count: 0, rules: [] });
  }
  for (const input of [
    "TOKEN=[REDACTED:SECRET]",
    '{"password":"[REDACTED:SECRET]"}',
    "https://example.invalid/?token=[REDACTED:URL_SECRET]",
    "https://example.invalid/?code=HTTP_OK",
    "Use code=ok and access: public",
    '{"access":"public","refresh":"manual","expiresIn":3600}',
    '{"access":"public","refresh":"manual","child":{"expires":123}}',
  ]) assert.deepEqual(redactText(input), { text: input, count: 0, rules: [] });
});

test("canonical turns remove OAuth token pairs only within the same credential object", async (t) => {
  const directory = await tempDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const credentials = { provider: { type: "oauth", access: '[REDACTED:OAUTH_TOKEN]CANARY"', profile: { scope: "read" }, refresh: "CANARY-refresh", expires: 123 }, settings: { access: "public", refresh: "manual" } };
  const input = JSON.stringify(credentials);
  const spool = await CanonicalSpool.create(directory, "agent-session:pi:oauth", "2026-01-01T00:00:00.000Z");
  await spool.add({ role: "user", content: input, timestamp: "2026-01-01T00:00:00.000Z" });
  await spool.finalize();
  const canonical = await fs.readFile(spool.path, "utf8");
  assert.doesNotMatch(canonical, /CANARY/);
  const turn = JSON.parse(canonical.split("\n")[1]!);
  const expected = { ...credentials, provider: { ...credentials.provider, access: "[REDACTED:OAUTH_TOKEN]", refresh: "[REDACTED:OAUTH_TOKEN]" } };
  assert.deepEqual(JSON.parse(turn.content), expected);
  assert.deepEqual(redactText(turn.content), { text: turn.content, count: 0, rules: [] });
  assert.equal(spool.stats.redactions, 2);
});

test("hash helper is stable", () => { assert.equal(sha256("abc"), sha256("abc")); });
