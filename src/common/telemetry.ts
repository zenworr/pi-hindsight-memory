import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { defaultRuntimePaths } from "./paths.js";
import { performance } from "node:perf_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { LoggerProvider, BatchLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { MS_PER_SECOND } from "./limits.js";

const SCOPE = "pi-hindsight-memory";
const EXPORT_TIMEOUT_MS = 3_000;
const EXPORT_INTERVAL_MS = 60_000;
const QUEUE_SIZE = 2_048;
const LOG_SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 } as const;
const SAFE_LOG_MESSAGES = new Set([
  "Import cycle complete", "Import cycle failed", "Imported session", "Session import failed",
  "Session import interrupted by shutdown", "Importer drained", "Historical cohort complete",
  "Repair progress", "Completed payload cleanup requires attention", "Completed operation payload could not be removed",
  "Command failed", "Health check complete", "Health check failed", "Telemetry started", "Telemetry stopping",
]);
const SAFE_LOG_NUMBERS = new Set(["discovered", "queued", "unchanged", "active", "completed", "failed", "deferred", "scanErrors", "selected", "cohort", "imported", "remaining"]);
const active = new AsyncLocalStorage<Span>();

interface Exporters { traceExporter: SpanExporter; metricExporter: PushMetricExporter; logExporter: LogRecordExporter; }
type Outcome = "ok" | "error" | "cancelled" | "incomplete";

function watchExport<T, R extends { code: number }>(signal: string, send: (batch: T, done: (result: R) => void) => void, health: Map<string, { failures: number; successAt?: number }>) {
  const state = { failures: 0, successAt: undefined as number | undefined };
  health.set(signal, state);
  return (batch: T, done: (result: R) => void) => {
    try {
      send(batch, (result) => {
        if (result.code === 0) state.successAt = Date.now();
        else state.failures += 1;
        done(result);
      });
    } catch (error) { state.failures += 1; throw error; }
  };
}

let runtime: ReturnType<typeof createRuntime> | undefined;
let users = 0;

function telemetryEnvironment(): Record<string, string | undefined> {
  const file = process.env.PI_HINDSIGHT_TELEMETRY_FILE ?? path.join(defaultRuntimePaths().configDirectory, "telemetry.env");
  const values: Record<string, string> = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const entry = /^(OTEL_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (entry) values[entry[1]!] = entry[2]!;
    }
  }
  return { ...values, ...process.env };
}

function endpoint(environment: Record<string, string | undefined>, signal: "traces" | "metrics" | "logs"): string | undefined {
  const specific = environment[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  const base = environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!specific && !base) return undefined;
  const url = new URL(specific ?? `${base!.replace(/\/$/, "")}/v1/${signal}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid OTLP endpoint");
  return url.href;
}

function createRuntime(service: string, exporters: Exporters, environment: Record<string, string | undefined>) {
  // Keep providers and context private: Pi can host other instrumented extensions.
  const manifest = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
  const deployment = environment.OTEL_DEPLOYMENT_ENVIRONMENT ?? "production";
  if (!["production", "development", "test"].includes(deployment)) throw new Error("Invalid telemetry environment");
  const resource = resourceFromAttributes({ "service.name": environment.OTEL_SERVICE_NAME ?? service, "service.version": manifest.version, "deployment.environment.name": deployment, "service.instance.id": `${os.hostname()}:${process.pid}`, "host.name": os.hostname(), "process.runtime.name": "nodejs", "process.runtime.version": process.version });
  const health = new Map<string, { failures: number; successAt?: number }>();
  exporters.traceExporter.export = watchExport("traces", exporters.traceExporter.export.bind(exporters.traceExporter), health);
  exporters.metricExporter.export = watchExport("metrics", exporters.metricExporter.export.bind(exporters.metricExporter), health);
  exporters.logExporter.export = watchExport("logs", exporters.logExporter.export.bind(exporters.logExporter), health);
  const traces = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(exporters.traceExporter, { maxQueueSize: QUEUE_SIZE, exportTimeoutMillis: EXPORT_TIMEOUT_MS })] });
  const meterProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: exporters.metricExporter, exportIntervalMillis: EXPORT_INTERVAL_MS, exportTimeoutMillis: EXPORT_TIMEOUT_MS })] });
  const logs = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: exporters.logExporter, maxQueueSize: QUEUE_SIZE, exportTimeoutMillis: EXPORT_TIMEOUT_MS })] });
  const tracer = traces.getTracer(SCOPE);
  const meter = meterProvider.getMeter(SCOPE);
  const duration = meter.createHistogram("hindsight.stage.duration", { unit: "s", description: "Duration of importer, retrieval, and service-client stages" });
  const operations = meter.createCounter("hindsight.stage.operations", { description: "Finished stage attempts by outcome" });
  const queueWait = meter.createHistogram("hindsight.import.queue_wait", { unit: "s", description: "Time from queue admission to the first worker attempt; excludes session settling" });
  meter.createObservableGauge("hindsight.telemetry.heartbeat", { unit: "s" }).addCallback((result) => { result.observe(Date.now() / MS_PER_SECOND); });
  meter.createObservableCounter("hindsight.telemetry.export_failures").addCallback((result) => {
    for (const [signal, state] of health) result.observe(state.failures, { signal });
  });
  meter.createObservableGauge("hindsight.telemetry.last_success_age", { unit: "s" }).addCallback((result) => {
    for (const [signal, state] of health) if (state.successAt !== undefined) result.observe((Date.now() - state.successAt) / MS_PER_SECOND, { signal });
  });
  const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  meter.createObservableGauge("process.memory.usage", { unit: "By" }).addCallback((result) => { result.observe(process.memoryUsage().rss); });
  meter.createObservableCounter("process.cpu.time", { unit: "s" }).addCallback((result) => {
    const usage = process.cpuUsage();
    const MICROSECONDS_PER_SECOND = 1_000_000;
    result.observe(usage.user / MICROSECONDS_PER_SECOND, { mode: "user" });
    result.observe(usage.system / MICROSECONDS_PER_SECOND, { mode: "system" });
  });
  meter.createObservableGauge("process.uptime", { unit: "s" }).addCallback((result) => { result.observe(process.uptime()); });
  return { traces, meterProvider, logs, tracer, meter, duration, operations, queueWait, gauges, counters, logger: logs.getLogger(SCOPE) };
}

export function startTelemetry(service: string, exporters?: Exporters): () => Promise<void> {
  try {
    const environment = telemetryEnvironment();
    if (environment.OTEL_SDK_DISABLED === "true" || !environment.OTEL_EXPORTER_OTLP_ENDPOINT && !environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT && !environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT && !environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return () => Promise.resolve();
    if (environment.OTEL_EXPORTER_OTLP_PROTOCOL && environment.OTEL_EXPORTER_OTLP_PROTOCOL !== "http/protobuf") throw new Error("Only OTLP HTTP/protobuf is supported");
    if (!runtime) {
      const traces = endpoint(environment, "traces"); const metrics = endpoint(environment, "metrics"); const logs = endpoint(environment, "logs");
      if (!traces || !metrics || !logs) throw new Error("Configure an OTLP base endpoint or all three signal endpoints");
      runtime = createRuntime(service, exporters ?? {
        traceExporter: new OTLPTraceExporter({ url: traces, timeoutMillis: EXPORT_TIMEOUT_MS }),
        metricExporter: new OTLPMetricExporter({ url: metrics, timeoutMillis: EXPORT_TIMEOUT_MS }),
        logExporter: new OTLPLogExporter({ url: logs, timeoutMillis: EXPORT_TIMEOUT_MS }),
      }, environment);
      telemetryLog("info", "telemetry", "Telemetry started");
    }
    users += 1;
  } catch {
    process.stderr.write("Hindsight telemetry could not start; memory processing will continue.\n");
    return () => Promise.resolve();
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users > 0 || !runtime) return;
    telemetryLog("info", "telemetry", "Telemetry stopping");
    const current = runtime;
    runtime = undefined;
    await Promise.allSettled([current.traces.shutdown(), current.meterProvider.shutdown(), current.logs.shutdown()]);
  };
}

export async function inSpan<T>(name: string, attributes: Attributes, work: (span?: Span) => Promise<T>, kind = SpanKind.INTERNAL, resultOutcome?: (result: T) => Outcome): Promise<T> {
  const current = runtime;
  if (!current) return work();
  const parent = active.getStore();
  const span = current.tracer.startSpan(name, { attributes, kind }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
  const started = performance.now();
  let outcome: Outcome = "incomplete";
  return active.run(span, async () => {
    try {
      const result = await work(span);
      outcome = resultOutcome?.(result) ?? "ok";
      return result;
    }
    catch (error) {
      outcome = error instanceof Error && error.name === "AbortError" ? "cancelled" : "error";
      // Error messages and stacks can contain source text, paths, and credentials.
      span.recordException({ name: outcome === "cancelled" ? "AbortError" : "OperationError", message: "Operation did not complete" });
      throw error;
    } finally {
      span.setAttribute("hindsight.outcome", outcome);
      if (outcome === "error") span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      const labels = { stage: name, outcome };
      current.duration.record((performance.now() - started) / MS_PER_SECOND, labels);
      current.operations.add(1, labels);
    }
  });
}

export function telemetryEnabled(): boolean { return runtime !== undefined; }

export function telemetryQueueWait(seconds: number, source: string): void {
  if (Number.isFinite(seconds) && seconds >= 0) runtime?.queueWait.record(seconds, { source });
}

export function traceHeaders(): Record<string, string> {
  const span = active.getStore();
  if (!span?.isRecording()) return {};
  const { traceId, spanId, traceFlags } = span.spanContext();
  const FLAGS_HEX_WIDTH = 2;
  const HEX_RADIX = 16;
  return { traceparent: `00-${traceId}-${spanId}-${traceFlags.toString(HEX_RADIX).padStart(FLAGS_HEX_WIDTH, "0")}` };
}

export function telemetryLog(level: keyof typeof LOG_SEVERITY, component: string, message: string, details?: Record<string, unknown>): void {
  if (!runtime) return;
  const attributes: Attributes = { component };
  for (const [key, value] of Object.entries(details ?? {})) {
    if (SAFE_LOG_NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value)) attributes[key] = value;
    if (key === "source" && ["pi", "codex", "claude", "opencode"].includes(String(value))) attributes[key] = String(value);
  }
  const span = active.getStore();
  runtime.logger.emit({ severityNumber: LOG_SEVERITY[level], severityText: level.toUpperCase(), body: SAFE_LOG_MESSAGES.has(message) ? message : "Application log", attributes, context: span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT });
}

export function telemetryGauge(name: string, value: number, attributes: Attributes = {}, unit = "1"): void {
  if (!runtime || !Number.isFinite(value)) return;
  let gauge = runtime.gauges.get(name);
  if (!gauge) { gauge = runtime.meter.createGauge(name, { unit }); runtime.gauges.set(name, gauge); }
  gauge.record(value, attributes);
}

export function telemetryCount(name: string, value: number, attributes: Attributes = {}): void {
  if (!runtime) return;
  let counter = runtime.counters.get(name);
  if (!counter) { counter = runtime.meter.createCounter(name); runtime.counters.set(name, counter); }
  counter.add(value, attributes);
}
