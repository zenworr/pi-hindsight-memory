import fs from "node:fs";
import type { AppConfig, ImportApproval } from "./types.js";

export interface ActiveProvider { provider: string; model: string; }

export function readEnvironmentFile(pathname: string): Record<string, string> {
  const output: Record<string, string> = {};
  if (!fs.existsSync(pathname)) return output;
  for (const raw of fs.readFileSync(pathname, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    output[match[1]!] = value;
  }
  return output;
}

export function activeProvider(config: AppConfig): ActiveProvider {
  const environment = readEnvironmentFile(config.hindsight.environmentFile || config.hindsightEnvironmentFile);
  return { provider: environment.HINDSIGHT_API_LLM_PROVIDER ?? "unknown", model: environment.HINDSIGHT_API_LLM_MODEL ?? "unknown" };
}

export function readApproval(pathname: string): ImportApproval | undefined {
  if (!fs.existsSync(pathname)) return undefined;
  const value: unknown = JSON.parse(fs.readFileSync(pathname, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Import approval is not an object: ${pathname}`);
  return value as ImportApproval;
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Import approval ${name} must be positive`);
  return value;
}

export function assertImportApproval(config: AppConfig): ImportApproval {
  const approval = readApproval(config.approvalFile);
  if (!approval) throw new Error(`No import approval exists at ${config.approvalFile}; durable import is paused`);
  const provider = activeProvider(config);
  if (!provider.provider || provider.provider === "unknown" || provider.provider === "none") throw new Error("Hindsight has no fact-extraction provider; durable import is paused");
  if (approval.provider !== provider.provider) throw new Error(`Import approval provider ${approval.provider} does not match active provider ${provider.provider}`);
  if (approval.model !== provider.model && approval.model !== "*") throw new Error(`Import approval model ${approval.model} does not match active model ${provider.model}`);
  if (approval.privacy !== "remote-redacted" && approval.privacy !== "local") throw new Error("Import approval privacy must be remote-redacted or local");
  const approvedAt = Date.parse(approval.approvedAt);
  if (Number.isNaN(approvedAt)) throw new Error("Import approval approvedAt must be an ISO date");
  positive(approval.maxEstimatedInputTokens, "maxEstimatedInputTokens");
  if (typeof approval.maxEstimatedCostUsd !== "number" || !Number.isFinite(approval.maxEstimatedCostUsd) || approval.maxEstimatedCostUsd < 0) throw new Error("Import approval maxEstimatedCostUsd must be non-negative");
  if (approval.inputUsdPerMillionTokens !== undefined && approval.inputUsdPerMillionTokens < 0) throw new Error("Import approval inputUsdPerMillionTokens must not be negative");
  if (approval.outputUsdPerMillionTokens !== undefined && approval.outputUsdPerMillionTokens < 0) throw new Error("Import approval outputUsdPerMillionTokens must not be negative");
  if (approval.outputTokenMultiplier !== undefined && (approval.outputTokenMultiplier < 0 || !Number.isFinite(approval.outputTokenMultiplier))) throw new Error("Import approval outputTokenMultiplier must be non-negative");
  if (approval.minFreeBytes !== undefined && (approval.minFreeBytes < 0 || !Number.isFinite(approval.minFreeBytes))) throw new Error("Import approval minFreeBytes must be non-negative");
  if (approval.maxFailureRate !== undefined && (approval.maxFailureRate <= 0 || approval.maxFailureRate > 1)) throw new Error("Import approval maxFailureRate must be in (0, 1]");
  return approval;
}

export function estimateInputTokens(canonicalBytes: number): number { return Math.max(1, Math.ceil(canonicalBytes / 4)); }
export function estimateCostUsd(tokens: number, approval: ImportApproval): number {
  const input = (approval.inputUsdPerMillionTokens ?? 0) * tokens / 1_000_000;
  const output = (approval.outputUsdPerMillionTokens ?? 0) * tokens * (approval.outputTokenMultiplier ?? 0.25) / 1_000_000;
  return input + output;
}
