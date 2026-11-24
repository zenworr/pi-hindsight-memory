import fs from "node:fs";
import { parseEnv } from "node:util";
import { positiveInteger } from "./config-validation.js";
import { CHARS_PER_ESTIMATED_TOKEN } from "./limits.js";

import type { AppConfig, ImportApproval } from "./types.js";

const TOKENS_PER_PRICING_UNIT = 1_000_000;
const DEFAULT_OUTPUT_TOKEN_MULTIPLIER = 0.25;

export interface ActiveProvider { provider: string; model: string; }

const APPROVAL_KEYS: Record<keyof ImportApproval, true> = {
  approvedAt: true, provider: true, model: true, privacy: true, alternateRoutes: true,
  maxEstimatedInputTokens: true, maxEstimatedCostUsd: true, inputUsdPerMillionTokens: true, outputUsdPerMillionTokens: true,
  outputTokenMultiplier: true, minFreeBytes: true, maxFailureRate: true, continuousMinFailureSample: true,
};
const APPROVAL_DATE = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function readEnvironmentFile(pathname: string): NodeJS.Dict<string> {
  return fs.existsSync(pathname) ? parseEnv(fs.readFileSync(pathname, "utf8")) : {};
}

function primaryRoute(environment: NodeJS.Dict<string>): ActiveProvider {
  return { provider: environment.HINDSIGHT_API_LLM_PROVIDER ?? "unknown", model: environment.HINDSIGHT_API_LLM_MODEL ?? "unknown" };
}

export function activeProvider(config: AppConfig): ActiveProvider {
  return primaryRoute(readEnvironmentFile(config.hindsight.environmentFile));
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "unknown" && !/\s/.test(value);
}

function providerIdentity(value: unknown): value is string {
  return identity(value) && value !== "*" && value !== "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Import approval ${name} must be a finite non-negative number`);
}

function validateApproval(value: unknown): asserts value is ImportApproval {
  if (!isRecord(value)) throw new Error("Import approval must be an object");
  if (Object.keys(value).some((key) => !Object.hasOwn(APPROVAL_KEYS, key))) throw new Error("Import approval contains an unknown key");
  const date = typeof value.approvedAt === "string" ? APPROVAL_DATE.exec(value.approvedAt)?.[1] : undefined;
  if (typeof value.approvedAt !== "string" || !date || !Number.isFinite(Date.parse(value.approvedAt)) || !new Date(date).toISOString().startsWith(date)) throw new Error("Import approval approvedAt must be an ISO date");
  if (!providerIdentity(value.provider)) throw new Error("Import approval provider must be a provider ID");
  if (!identity(value.model)) throw new Error("Import approval model must be a model ID or *");
  if (value.privacy !== "remote-redacted" && value.privacy !== "local") throw new Error("Import approval privacy must be remote-redacted or local");
  if (value.maxEstimatedInputTokens !== null) positiveInteger(value.maxEstimatedInputTokens, "Import approval maxEstimatedInputTokens");
  nonNegative(value.maxEstimatedCostUsd, "maxEstimatedCostUsd");
  for (const key of ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "outputTokenMultiplier"] as const) {
    if (value[key] !== undefined) nonNegative(value[key], key);
  }
  if (value.minFreeBytes !== undefined) positiveInteger(value.minFreeBytes, "Import approval minFreeBytes", true);
  if (value.continuousMinFailureSample !== undefined) positiveInteger(value.continuousMinFailureSample, "Import approval continuousMinFailureSample");
  const rate = value.maxFailureRate;
  if (rate !== undefined && (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1)) throw new Error("Import approval maxFailureRate must be in (0, 1]");
  if (value.alternateRoutes !== undefined && (!Array.isArray(value.alternateRoutes) || value.alternateRoutes.some((route: unknown) =>
    !isRecord(route) || Object.keys(route).some((key) => key !== "provider" && key !== "model") || !providerIdentity(route.provider) || !identity(route.model) || route.model === "*"))) {
    throw new Error("Import approval alternateRoutes must contain only exact provider and model IDs");
  }
}

export function readApproval(pathname: string): ImportApproval | undefined {
  if (!fs.existsSync(pathname)) return undefined;
  const json = fs.readFileSync(pathname, "utf8");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error("Import approval must be valid JSON"); }
  validateApproval(value);
  return value;
}

export function assertImportApproval(config: AppConfig): ImportApproval {
  const approval = readApproval(config.approvalFile);
  if (!approval) throw new Error(`No import approval exists at ${config.approvalFile}; durable import is paused`);
  const environment = readEnvironmentFile(config.hindsight.environmentFile);
  const primary = primaryRoute(environment);
  if (!providerIdentity(primary.provider)) throw new Error("Hindsight has no fact-extraction provider; durable import is paused");
  if (approval.provider !== primary.provider) throw new Error("Import approval provider does not match active provider");
  if (!identity(primary.model) || primary.model === "*" || (approval.model !== primary.model && approval.model !== "*")) throw new Error("Import approval model does not match active model");
  const indexes = new Set<string>();
  for (const key of Object.keys(environment)) {
    const index = /^HINDSIGHT_API_LLM_(\d+)_(?:PROVIDER|MODEL)$/.exec(key)?.[1];
    if (index !== undefined) indexes.add(index);
  }
  for (const index of indexes) {
    const provider = environment[`HINDSIGHT_API_LLM_${index}_PROVIDER`];
    const model = environment[`HINDSIGHT_API_LLM_${index}_MODEL`];
    if (!approval.alternateRoutes?.some((route) => route.provider === provider && route.model === model)) {
      throw new Error(`Import approval does not match active alternate route ${index}; both provider and model must be declared and approved`);
    }
  }
  return approval;
}

export function estimateInputTokens(canonicalBytes: number): number { return Math.max(1, Math.ceil(canonicalBytes / CHARS_PER_ESTIMATED_TOKEN)); }
export function estimateCostUsd(tokens: number, approval: ImportApproval): number {
  const input = (approval.inputUsdPerMillionTokens ?? 0) * tokens / TOKENS_PER_PRICING_UNIT;
  const output = (approval.outputUsdPerMillionTokens ?? 0) * tokens * (approval.outputTokenMultiplier ?? DEFAULT_OUTPUT_TOKEN_MULTIPLIER) / TOKENS_PER_PRICING_UNIT;
  return input + output;
}
