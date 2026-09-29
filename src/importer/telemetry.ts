import fs from "node:fs/promises";
import { inSpan, telemetryGauge, telemetryLog, telemetryEnabled } from "../common/telemetry.js";
import { MS_PER_SECOND } from "../common/limits.js";
import type { AppConfig } from "../common/types.js";
import { collectHindsightStatus } from "../extension/status.js";
import { HindsightClient } from "../hindsight/client.js";

const HEALTH_INTERVAL_MS = 60_000;

export function startHealthTelemetry(config: AppConfig): () => Promise<void> {
  if (!telemetryEnabled()) return () => Promise.resolve();
  const client = new HindsightClient(config.hindsight);
  let pending: Promise<void> | undefined;
  const sample = () => {
    pending ??= inSpan("hindsight.health", {}, async () => {
      const status = await collectHindsightStatus(config, client);
      const importer = status.importer;
      const service = status.service;
      telemetryGauge("hindsight.importer.running", Number(importer.running));
      telemetryGauge("hindsight.importer.paused", Number(importer.paused));
      telemetryGauge("hindsight.importer.cycle_error", Number(Boolean(importer.lastError)));
      for (const state of ["queued", "submitted", "processing", "failed", "cleanupPending"] as const) telemetryGauge("hindsight.importer.generations", importer[state], { state });
      for (const state of ["scanErrors", "deferred", "unprocessed", "staleSources", "uncertain"] as const) telemetryGauge("hindsight.importer.coverage", importer[state], { state });
      telemetryGauge("hindsight.importer.heartbeat_age", importer.heartbeatAt ? (Date.now() - Date.parse(importer.heartbeatAt)) / MS_PER_SECOND : -1, {}, "s");
      if (config.desktopFeed.enabled) {
        telemetryGauge("hindsight.feed.age", importer.desktopFeedAgeSeconds ?? -1, {}, "s");
        telemetryGauge("hindsight.feed.stale", Number(importer.desktopFeedStale));
      }
      telemetryGauge("hindsight.server.healthy", Number(service.healthy));
      telemetryGauge("hindsight.server.database_connected", Number(service.databaseConnected));
      telemetryGauge("hindsight.server.documents", service.documents);
      telemetryGauge("hindsight.server.operations", service.pendingOperations, { state: "pending" });
      telemetryGauge("hindsight.server.operations", service.processingOperations, { state: "processing" });
      telemetryGauge("hindsight.server.consolidation", service.pendingConsolidation, { state: "pending" });
      telemetryGauge("hindsight.server.consolidation", service.failedConsolidation, { state: "failed" });
      telemetryGauge("hindsight.setup.issues", status.issues.length);
      const disk = await fs.statfs(config.stateDirectory);
      telemetryGauge("hindsight.importer.disk.available", Number(disk.bavail) * Number(disk.bsize), {}, "By");
      telemetryGauge("hindsight.setup.monitor_error", 0);
      telemetryLog(status.issues.length ? "warn" : "info", "health", "Health check complete");
    }).catch(() => {
      telemetryGauge("hindsight.setup.monitor_error", 1);
      telemetryLog("error", "health", "Health check failed");
    }).finally(() => { pending = undefined; });
  };
  const timer = setInterval(sample, HEALTH_INTERVAL_MS);
  timer.unref();
  sample();
  return async () => { clearInterval(timer); await pending; };
}
