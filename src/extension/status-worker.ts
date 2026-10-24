import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../common/types.js";
import { generationCounts } from "../importer/state-db.js";
import { importerHealth } from "../importer/health.js";

const config = workerData as AppConfig;
const db = new DatabaseSync(config.stateDatabase, { readOnly: true, timeout: 500 });
try {
  db.exec("BEGIN");
  const counts = generationCounts(db);
  parentPort!.postMessage({
    queued: counts.queued ?? 0,
    submitted: counts.submitted ?? 0,
    processing: counts.processing ?? 0,
    failed: counts.failed ?? 0,
    cleanupPending: counts.cleanup_pending ?? 0,
    ...importerHealth(config, db),
  });
} finally { db.close(); }
