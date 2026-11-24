import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { startTelemetry } from "../../src/common/telemetry.js";
import { startHealthTelemetry } from "../../src/importer/telemetry.js";
import { defaultConfig } from "../../src/common/config.js";
import { collectHindsightStatus } from "../../src/extension/status.js";
import { StateDatabase, UNRESOLVED_SUBMISSION } from "../../src/importer/state-db.js";
import { STALE_REDACTION_PAYLOAD } from "../../src/importer/pending-payload.js";

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-health-"));
  const config = defaultConfig(root);
  config.hindsight.httpMaxAttempts = 1;
  await fs.mkdir(path.dirname(config.hindsight.apiTokenFile), { recursive: true });
  await fs.writeFile(config.hindsight.apiTokenFile, "test-fixture", { mode: 0o600 });
  let connected = true;
  let statsAvailable = true;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    res.setHeader("Content-Type", "application/json");
    if (url === "/health") res.end(JSON.stringify({ status: "healthy", database: connected ? "connected" : "disconnected" }));
    else if (url.endsWith("/stats") && statsAvailable) res.end(JSON.stringify({ total_documents: 0, failed_operations: 42 }));
    else if (url.includes("/operations?")) res.end(JSON.stringify({ operations: [] }));
    else { res.statusCode = 503; res.end("{}"); }
  });
  t.after(async () => {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  config.hindsight.apiUrl = `http://127.0.0.1:${address.port}`;
  return { root, config, requests, disconnect: () => { connected = false; }, failStats: () => { statsAvailable = false; } };
}

test("status reports a proactive disk block, failed and overdue updates, then clears on recovery", async (t) => {
  const { config, requests } = await fixture(t);
  const state = new StateDatabase(config.stateDatabase);
  t.after(() => { state.close(); });
  state.heartbeat("idle");
  const approval = { approvedAt: "2026-01-01", provider: "local", model: "test", privacy: "local", maxEstimatedInputTokens: null, maxEstimatedCostUsd: 0 };
  await fs.mkdir(path.dirname(config.approvalFile), { recursive: true });
  await fs.writeFile(config.approvalFile, JSON.stringify({ ...approval, minFreeBytes: Number.MAX_SAFE_INTEGER }));
  const low = await collectHindsightStatus(config);
  assert.equal(low.importer.failed, 0);
  assert.equal(low.importer.blocked?.reason, "disk-below-minimum");
  assert.match(low.issues.join(" "), /free disk below approved minimum \(\d+\.\d\/\d+\.\d GiB\) — Free space; imports resume automatically/);
  await fs.writeFile(config.approvalFile, JSON.stringify({ ...approval, minFreeBytes: 0 }));

  const now = new Date().toISOString();
  const old = new Date(Date.now() - (config.importer.overdueSubmissionSeconds + 120) * 1_000).toISOString();
  state.upsertSession({ source: "pi", nativeSessionId: "session", documentId: "session", sourceLocator: "/fixture", sourceSize: 1, sourceMtime: 1, sourceFingerprint: { size: 1, mtimeMs: 1, sampleHash: "h", stableLocator: "/fixture" }, status: "discovered", lastSeenAt: now });
  const add = (hash: string, status: "failed" | "submitted", submittedAt: string, operationStatus?: string, error?: string) => {
    state.upsertGeneration({ source: "pi", nativeSessionId: "session", canonicalHash: hash, operationId: hash, state: status, queuedAt: submittedAt, submittedAt, attemptCount: config.importer.maxAttempts, error });
    if (operationStatus) state.upsertOperation({ operationId: hash, documentId: "session", canonicalHash: hash, hindsightStatus: operationStatus, retryCount: 0 });
  };
  add("failed", "failed", now, "failed", "CANARY_PRIVATE_GENERATION_ERROR");
  add("disk", "failed", now, undefined, "Free disk space is below the approved minimum");
  add("overdue", "submitted", old, "pending");
  state.recordOperationPoll("overdue", "pending", undefined, "2099-10-22T06:13:12.000Z");
  add("new", "submitted", now, "pending");
  state.recordOperationPoll("new", "pending", undefined, "2099-10-21T06:13:12.000Z");
  add("unresolved", "submitted", now, UNRESOLVED_SUBMISSION);
  add("quarantined", "submitted", now, "ready", STALE_REDACTION_PAYLOAD);
  const stalled = await collectHindsightStatus(config);
  assert.equal(stalled.importer.overdueSubmissions, 1);
  assert.equal(stalled.importer.oldestSubmittedAt, old);
  assert.ok(stalled.importer.oldestSubmittedAgeSeconds! >= config.importer.overdueSubmissionSeconds);
  assert.match(stalled.issues.join(" "), /2 session updates failed \(disk-below-minimum: 1; operation-failed: 1\) — fix cause; run retry-failed/);
  assert.match(stalled.issues.join(" "), /1 overdue submissions \(oldest 2\.\d h; remote retry scheduled 2099-10-22 06:13 UTC\) — check Hindsight operations/);
  assert.match(stalled.issues.join(" "), /1 unresolved submissions — review before retry-unresolved/);
  assert.match(stalled.issues.join(" "), /1 payloads use an old redaction policy/);
  assert.doesNotMatch(JSON.stringify(stalled), /CANARY_PRIVATE_GENERATION_ERROR/);
  assert.ok(!requests.some((url) => /\/operations\//.test(url)));
  state.db.exec("UPDATE generations SET state='superseded'");
  state.heartbeat("idle");
  const recovered = await collectHindsightStatus(config);
  assert.equal(recovered.importer.failed, 0);
  assert.equal(recovered.importer.overdueSubmissions, 0);
  assert.equal(recovered.service.failedOperations, 42);
  assert.deepEqual(recovered.issues, []);
});

test("status distinguishes unavailable measurements from successful zero readings", async (t) => {
  const { config, failStats } = await fixture(t);
  const state = new StateDatabase(config.stateDatabase);
  state.close();
  const known = await collectHindsightStatus(config);
  assert.equal(known.importer.available, true);
  assert.equal(known.service.available, true);
  assert.equal(known.importer.queued, 0);
  assert.equal(known.service.documents, 0);
  await fs.rm(config.stateDatabase);
  failStats();
  const partial = await collectHindsightStatus(config);
  assert.deepEqual(partial.importer, { available: false });
  assert.equal(partial.service.available, false);
  assert.equal(partial.service.documents, undefined);
  assert.equal(partial.service.healthy, true);
  assert.equal(partial.service.processingOperations, 0);
  assert.match(partial.issues.join(" "), /Importer state unavailable.*Hindsight bank statistics unavailable/);
  assert.doesNotMatch(partial.issues.join(" "), /unhealthy|disconnected/);
});

test("health telemetry omits failed samples and reports a partial monitor error", async (t) => {
  const { config, failStats } = await fixture(t);
  await fs.mkdir(config.stateDirectory, { recursive: true });
  failStats();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logExporter = new InMemoryLogRecordExporter();
  const traceExporter = new InMemorySpanExporter();
  const before = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = config.hindsight.apiUrl;
  t.after(() => { if (before === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = before; });
  const stop = startTelemetry("hindsight-test", { metricExporter, logExporter, traceExporter });
  try {
    await startHealthTelemetry(config)();
  } finally { await stop(); }
  const metrics = metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  const values = (name: string) => metrics.find((metric) => metric.descriptor.name === name)?.dataPoints.map((point) => point.value);
  assert.deepEqual(values("hindsight.setup.monitor_error"), [1]);
  assert.deepEqual(values("hindsight.server.healthy"), [1]);
  assert.deepEqual(values("hindsight.server.operations"), [0]);
  assert.equal(values("hindsight.server.documents"), undefined);
  assert.equal(values("hindsight.importer.generations"), undefined);
});

test("doctor rejects a disconnected database despite HTTP 200 and healthy API status", async (t) => {
  const { root, config, disconnect } = await fixture(t);
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ hindsight: config.hindsight }));
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve("dist/src/importer/cli.js"), "doctor", "--config", configPath], {
      env: { HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, PI_HINDSIGHT_TELEMETRY_FILE: "/dev/null" }, timeout: 10_000,
    });
    return (JSON.parse(stdout) as { hindsight: string }).hindsight;
  };
  assert.equal(await run(), "healthy");
  disconnect();
  assert.equal(await run(), "unhealthy: database is disconnected");
});

test("status accepts a config object from an older in-process extension version", async (t) => {
  const { config } = await fixture(t);
  const state = new StateDatabase(config.stateDatabase);
  t.after(() => { state.close(); });
  state.heartbeat("idle");
  const older = { ...config, importer: { retryDelayMs: 30_000, maxAttempts: 3 } } as unknown as typeof config;
  const status = await collectHindsightStatus(older);
  assert.equal(status.importer.available, true);
  assert.deepEqual(status.issues.filter((issue) => issue.startsWith("Importer state unavailable")), []);
});
