import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PRIVATE_FILE_MODE } from "../common/limits.js";
import type { AppConfig } from "../common/types.js";
import { StateDatabase } from "./state-db.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const SQLITE_BUSY = 5;

function resolveStateDatabase(databasePath: string): string {
  const absolute = path.resolve(databasePath);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || fs.lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    return path.join(fs.realpathSync.native(directory), path.basename(absolute));
  }
}

export async function withWriterLock<T>(databasePath: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${resolveStateDatabase(databasePath)}.writer-lock`;
  // Do not open and close an ordinary descriptor on an existing sidecar: that can release this process's SQLite locks.
  try { fs.closeSync(fs.openSync(lockPath, "wx", PRIVATE_FILE_MODE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!fs.lstatSync(lockPath).isFile()) throw new Error(`Writer lock is not a regular file (${lockPath})`);
  fs.chmodSync(lockPath, PRIVATE_FILE_MODE);

  const lock = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    try { lock.exec("BEGIN EXCLUSIVE"); }
    catch (error) {
      if (error instanceof Error && "errcode" in error && error.errcode === SQLITE_BUSY) {
        throw new Error(`Importer writer lock is busy (${lockPath}); run scripts/importer-service.sh stop if the importer service is running, or wait for the other writer to finish`, { cause: error });
      }
      throw error;
    }
    return await fn();
  } finally { lock.close(); }
}

export async function withStateLock<T>(config: AppConfig, fn: (state: StateDatabase) => T | Promise<T>): Promise<T> {
  return withWriterLock(config.stateDatabase, async () => {
    const state = new StateDatabase(config.stateDatabase);
    try { return await fn(state); }
    finally { state.close(); }
  });
}
