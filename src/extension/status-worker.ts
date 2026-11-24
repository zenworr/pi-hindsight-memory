import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../common/types.js";
import { defaultConfig } from "../common/config.js";
import { generationCounts } from "../importer/state-db.js";
import { importerHealth, inspectImportDisk } from "../importer/health.js";
import type { ImporterStatus } from "./status.js";

// Pi reloads keep the caller's modules cached while this worker loads current files, so fill settings an older caller lacks.
function withDefaults(received: AppConfig): AppConfig {
  const defaults = defaultConfig();
  const config = { ...defaults, ...received } as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    const current = config[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) config[key] = { ...value, ...current };
  }
  return config as unknown as AppConfig;
}

const config = withDefaults(workerData as AppConfig);
const db = new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
try {
  const disk = await inspectImportDisk(config);
  db.exec("BEGIN");
  const counts = generationCounts(db);
  const snapshot: ImporterStatus = {
    available: true,
    queued: counts.queued ?? 0,
    submitted: counts.submitted ?? 0,
    processing: counts.processing ?? 0,
    failed: counts.failed ?? 0,
    cleanupPending: counts.cleanup_pending ?? 0,
    ...importerHealth(config, db, disk),
  };
  parentPort!.postMessage(snapshot);
} finally { db.close(); }
