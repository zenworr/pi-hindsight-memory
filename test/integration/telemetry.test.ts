import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { startTelemetry } from "../../src/common/telemetry.js";
import { defaultConfig } from "../../src/common/config.js";
import { StateDatabase } from "../../src/importer/state-db.js";
import { scan } from "../../src/importer/scanner.js";
import { ImportWorker } from "../../src/importer/worker.js";
import type { HindsightClient } from "../../src/hindsight/client.js";

test("instrumented normalization, indexing, payload persistence, and retain preserve import behavior", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-hm-otel-"));
  const config = defaultConfig(root); config.requireImportApproval = false;
  await fs.mkdir(config.sourceRoots.pi, { recursive: true });
  await fs.writeFile(path.join(config.sourceRoots.pi, "session.jsonl"), [
    { type: "session", id: "CANARY_SESSION", timestamp: "2026-09-29T00:00:00Z" },
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Record CANARY_PRIVATE_CONTENT as a project outcome." }] } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "The project outcome is CANARY_PRIVATE_CONTENT." }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const state = new StateDatabase(config.stateDatabase);
  const traceExporter = new InMemorySpanExporter(); traceExporter.shutdown = () => Promise.resolve();
  const before = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const stop = startTelemetry("hindsight-test", { traceExporter, metricExporter, logExporter: new InMemoryLogRecordExporter() });
  let retains = 0;
  const client = {
    ensureBank: async () => undefined, assertBankConfiguration: async () => ({}), assertExtractionAvailable: async () => undefined,
    retainWithOperationId: async (_session: unknown, operationId: string) => { retains++; return { operation_id: operationId }; },
    waitForOperation: async () => ({ status: "completed" }),
  } as unknown as HindsightClient;
  try {
    const scanned = await scan(config, state, { force: true });
    assert.equal(scanned.queued, 1); assert.equal(scanned.errors, 0);
    const generation = state.listWorkCandidates(1, config.importer.maxAttempts)[0]!;
    state.upsertGeneration({ ...generation, queuedAt: new Date(Date.now() - 20_000).toISOString() });
    const worked = await new ImportWorker(config, state, client).runOnce();
    assert.equal(worked.completed, 1); assert.equal(retains, 1);
    assert.equal(state.pendingWorkCount(config.importer.maxAttempts), 0);
    await stop();
    const spans = traceExporter.getFinishedSpans();
    for (const name of ["hindsight.scan", "hindsight.source.discover", "hindsight.source.normalize", "hindsight.evidence.index", "hindsight.import.generation", "hindsight.payload.persist", "hindsight.retain.submit"]) assert.ok(spans.some((span) => span.name === name), name);
    assert.doesNotMatch(JSON.stringify(spans.map(({ name, attributes, events, status }) => ({ name, attributes, events, status }))), /CANARY/);
    const queue = metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)).find((metric) => metric.descriptor.name === "hindsight.import.queue_wait")!;
    assert.equal(queue.dataPoints.length, 1);
    assert.equal(queue.dataPoints[0]!.attributes.source, "pi");
    assert.ok(Number((queue.dataPoints[0]!.value as { sum: number }).sum) >= 20);
  } finally {
    await stop();
    if (before === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = before;
    state.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
