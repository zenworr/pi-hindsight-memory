import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig, ImportBlockReason } from "../common/types.js";

export const BLOCK_ACTIONS: Record<ImportBlockReason, string> = {
  "disk-below-minimum": "Free disk space on the importer state and spool filesystems, and check that both are accessible.",
  "approval-missing": "Create a reviewed import approval.",
  "approval-invalid": "Correct the import approval file.",
  "provider-not-approved": "Review the active provider and model, then update the import approval.",
  "budget-exceeded": "Review the cumulative budget and approve a new limit if appropriate.",
  "extraction-unavailable": "Check the Hindsight extraction provider and bank policy.",
  "hindsight-unreachable": "Check access to the Hindsight API.",
};

async function availableBytes(directory: string): Promise<number> {
  try {
    const filesystem = await fs.statfs(directory);
    return Number(filesystem.bavail) * Number(filesystem.bsize);
  } catch (error) {
    const parent = path.dirname(directory);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === directory) throw error;
    return availableBytes(parent);
  }
}

export async function importFreeBytes(config: AppConfig, databasePath: string): Promise<number> {
  const stateDirectory = databasePath === ":memory:" ? config.stateDirectory : path.dirname(databasePath);
  const available = await Promise.all([...new Set([stateDirectory, config.spoolDirectory])].map(availableBytes));
  return Math.min(...available);
}
