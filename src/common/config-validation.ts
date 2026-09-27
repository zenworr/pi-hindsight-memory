import type { AppConfig } from "./types.js";
import { MAX_TIMER_MS } from "./limits.js";

export function validateOverrides(value: unknown, defaults: object, prefix = ""): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${prefix || "config"} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown config key: ${name}; run config --defaults to list supported settings`);
    const expected: unknown = Reflect.get(defaults, key);
    if (Array.isArray(expected)) {
      if (!Array.isArray(item) || item.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) throw new Error(`${name} must contain non-empty strings`);
    } else if (expected && typeof expected === "object") {
      validateOverrides(item, expected, name);
    } else if (typeof item !== typeof expected || (typeof item === "string" && !item.trim())) {
      throw new Error(`${name} must be ${typeof expected === "string" ? "a non-empty string" : `a ${typeof expected}`}`);
    }
  }
}

export function positiveInteger(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return value;
}

export function validateConfig(config: AppConfig): AppConfig {
  for (const [name, address] of [["apiUrl", config.hindsight.apiUrl], ["uiUrl", config.hindsight.uiUrl]] as const) {
    if (address === undefined) continue;
    let url: URL;
    try { url = new URL(address); } catch { throw new Error(`hindsight.${name} must be a valid HTTP or HTTPS URL`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`hindsight.${name} must use HTTP or HTTPS without credentials, a query, or a fragment`);
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(config.localOrigin)) throw new Error("localOrigin must be a simple lowercase name");
  if (config.desktopFeed.enabled && config.localOrigin === "desktop") throw new Error("A desktop feed requires a separate localOrigin");
  if (config.desktopFeed.maxAgeSeconds !== undefined) positiveInteger(config.desktopFeed.maxAgeSeconds, "desktopFeed.maxAgeSeconds");
  for (const [source, ids] of Object.entries(config.promotedSessions)) {
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate promoted session ID in ${source}`);
    if (ids.length && !config.desktopFeed.enabled) throw new Error("Promoted sessions require a desktop feed");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(config.hindsight.bankId)) throw new Error("hindsight.bankId must contain only letters, digits, underscores, or hyphens");
  for (const name of ["maxCanonicalBytes", "scanIntervalSeconds", "maxInflightDocuments"] as const) positiveInteger(config[name], name);
  positiveInteger(config.sessionSettleSeconds, "sessionSettleSeconds", true);
  for (const [key, value] of Object.entries(config.importer)) positiveInteger(value, `importer.${key}`);
  for (const [key, value] of Object.entries(config.hindsight)) {
    if (typeof value !== "number") continue;
    if (key === "minRelevanceScore") {
      if (!Number.isFinite(value) || value < 0) throw new Error("hindsight.minRelevanceScore must be a finite non-negative number");
    } else {
      positiveInteger(value, `hindsight.${key}`, key.startsWith("recall") || key === "operationRetentionDays");
      if (key.endsWith("Ms") && value > MAX_TIMER_MS) throw new Error(`hindsight.${key} exceeds the Node timer limit (${MAX_TIMER_MS} ms)`);
    }
  }
  if (config.importer.retryDelayMs > MAX_TIMER_MS) throw new Error(`importer.retryDelayMs exceeds the Node timer limit (${MAX_TIMER_MS} ms)`);
  if (config.hindsight.httpRetryDelayMs > config.hindsight.httpMaxRetryDelayMs) throw new Error("hindsight.httpMaxRetryDelayMs must be at least httpRetryDelayMs");
  return config;
}
