import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { defaultConfig } from "../../dist/src/common/config.js";
import { startTelemetry } from "../../dist/src/common/telemetry.js";
import { StateDatabase } from "../../dist/src/importer/state-db.js";
import { scan } from "../../dist/src/importer/scanner.js";
import { ImportWorker } from "../../dist/src/importer/worker.js";
import { AggregationTemporality } from "@opentelemetry/sdk-metrics";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "hindsight-overhead-"));
const config = defaultConfig(root);
config.requireImportApproval = false;
const count = 100;
for (const directory of Object.values(config.sourceRoots)) await fs.mkdir(directory, { recursive: true });
for (let i = 0; i < count; i++) {
  await fs.writeFile(path.join(config.sourceRoots.pi, `${i}.jsonl`), [
    { type: "session", id: `synthetic-${i}`, timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "u", message: { role: "user", content: "Use a read-only source and a durable queue for the coding-history importer." } },
    { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "The importer uses read-only discovery, a SQLite queue, and atomic payload persistence." } },
  ].map(JSON.stringify).join("\n") + "\n");
}
const state = new StateDatabase(config.stateDatabase);
const enabled = process.argv[2] === "enabled";
process.env.PI_HINDSIGHT_TELEMETRY_FILE = "/dev/null";
process.env.OTEL_SDK_DISABLED = enabled ? "false" : "true";
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:1";
process.env.OTEL_DEPLOYMENT_ENVIRONMENT = "test";
const exporter = { export: (_batch, done) => done({ code: 0 }), shutdown: () => Promise.resolve(), forceFlush: () => Promise.resolve() };
const stop = startTelemetry("hindsight-overhead-test", {
  traceExporter: { ...exporter }, logExporter: { ...exporter },
  metricExporter: { ...exporter, selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE },
});
const client = {
  ensureBank: () => Promise.resolve(), assertBankConfiguration: () => Promise.resolve({}), assertExtractionAvailable: () => Promise.resolve(),
  retainWithOperationId: (_session, id) => Promise.resolve({ operation_id: id }), waitForOperation: () => Promise.resolve({ status: "completed" }),
};
const logger = { info() {}, warn() {}, error() {} };
try {
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const discovered = await scan(config, state, { force: true });
  const result = await new ImportWorker(config, state, client, logger).runOnce(count);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const rssAfter = process.memoryUsage().rss;
  if (discovered.queued !== count || result.completed !== count || result.failed) throw new Error("Benchmark workflow failed");
  process.stdout.write(JSON.stringify({ mode: enabled ? "enabled" : "disabled", sessions: count, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, rssDeltaBytes: rssAfter - rssBefore, rssAfterBytes: rssAfter }) + "\n");
} finally { await stop(); state.close(); await fs.rm(root, { recursive: true, force: true }); }
