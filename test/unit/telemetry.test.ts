import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { startTelemetry, inSpan, telemetryCount, telemetryGauge, telemetryLog, traceHeaders, telemetryEnabled } from "../../src/common/telemetry.js";
import { defaultConfig } from "../../src/common/config.js";
import { HindsightClient } from "../../src/hindsight/client.js";

function exporters() {
  const traceExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  traceExporter.shutdown = () => Promise.resolve();
  logExporter.shutdown = () => Promise.resolve();
  return { traceExporter, logExporter, metricExporter };
}

function enabled() {
  const before = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
  return () => { if (before === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = before; };
}

test("telemetry has nested spans, correlated safe logs, metrics, and no global provider changes", async () => {
  const restore = enabled(); const e = exporters();
  const global = trace.getTracerProvider();
  const stop = startTelemetry("hindsight-test", e);
  let expectedTrace = "";
  try {
    await inSpan("cycle", {}, async (parent) => {
      expectedTrace = parent!.spanContext().traceId;
      await Promise.all(["pi", "codex"].map((source) => inSpan("normalize", { source }, async () => {
        await Promise.resolve();
        telemetryLog("info", "worker", "Imported session", { source, session: "CANARY_PRIVATE_SESSION", error: "CANARY_SECRET", queued: 3 });
        assert.match(traceHeaders().traceparent!, new RegExp(expectedTrace));
      })));
      telemetryGauge("test.queue", 3);
      telemetryCount("test.completed", 2);
    });
    await stop(); await stop();
    const spans = e.traceExporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === "cycle")!;
    assert.equal(spans.length, 3);
    for (const child of spans.filter((span) => span.name === "normalize")) assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId);
    const logs = e.logExporter.getFinishedLogRecords().filter((record) => record.body === "Imported session");
    assert.equal(logs.length, 2);
    assert.ok(logs.every((record) => record.spanContext?.traceId === expectedTrace));
    assert.doesNotMatch(JSON.stringify(logs), /CANARY/);
    const metrics = e.metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    assert.ok(metrics.some((metric) => metric.descriptor.name === "test.queue"));
    assert.ok(metrics.some((metric) => metric.descriptor.name === "test.completed"));
    assert.equal(trace.getTracerProvider(), global);
    assert.equal(telemetryEnabled(), false);
  } finally { await stop(); restore(); }
});

test("HTTP propagation excludes request bodies, identifiers, query strings, and errors", async () => {
  const restore = enabled(); const e = exporters(); const stop = startTelemetry("hindsight-test", e);
  const config = defaultConfig("/tmp/test").hindsight;
  config.apiUrl = "http://example.test"; config.bankId = "CANARY_BANK"; config.httpMaxAttempts = 1;
  const requests: RequestInit[] = [];
  const client = new HindsightClient(config, async (_url, init) => { requests.push(init!); return new Response("{}", { status: 200 }); }, "CANARY_TOKEN");
  try {
    await inSpan("search", {}, async () => { await client.requestJson("POST", "http://example.test/v1/default/banks/CANARY_BANK/memories/recall?query=CANARY_QUERY", { query: "CANARY_QUERY" }); });
    await assert.rejects(inSpan("failure", {}, async () => { throw new Error("CANARY_SECRET /private/file"); }));
    await stop();
    assert.match((requests[0]!.headers as Record<string, string>).traceparent!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const spans = e.traceExporter.getFinishedSpans();
    assert.doesNotMatch(JSON.stringify(spans.map(({ name, attributes, events, status }) => ({ name, attributes, events, status }))), /CANARY|private\/file/);
    assert.equal(spans.find((span) => span.name === "failure")?.status.code, SpanStatusCode.ERROR);
    assert.equal(spans.find((span) => span.name === "hindsight.http.attempt")?.attributes["http.route"], "/banks/{bank}/memories/recall");
  } finally { await stop(); restore(); }
});

test("telemetry is optional, reference-counted, and can restart after reload", async () => {
  assert.equal(telemetryEnabled(), false);
  assert.deepEqual(traceHeaders(), {});
  assert.equal(await inSpan("disabled", {}, () => Promise.resolve(42)), 42);
  const restore = enabled(); const e = exporters();
  try {
    const first = startTelemetry("hindsight-test", e);
    const second = startTelemetry("hindsight-test", e);
    await first(); assert.equal(telemetryEnabled(), true);
    await second(); assert.equal(telemetryEnabled(), false);
    const next = startTelemetry("hindsight-test", exporters());
    assert.equal(telemetryEnabled(), true); await next();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://user:secret@example.test";
    const invalid = startTelemetry("hindsight-test");
    assert.equal(telemetryEnabled(), false);
    assert.equal(await inSpan("disabled", {}, () => Promise.resolve(42)), 42);
    await invalid();
  } finally { restore(); }
});

test("collector failure does not fail application work or shutdown", async () => {
  const restore = enabled(); const e = exporters();
  e.traceExporter.export = (_spans, done) => { done({ code: 1, error: new Error("collector offline") }); };
  e.metricExporter.export = (_metrics, done) => { done({ code: 1, error: new Error("collector offline") }); };
  e.logExporter.export = (_logs, done) => { done({ code: 1, error: new Error("collector offline") }); };
  const stop = startTelemetry("hindsight-test", e);
  try {
    assert.equal(await inSpan("work", {}, () => Promise.resolve(42)), 42);
    await stop();
  } finally { await stop(); restore(); }
});
