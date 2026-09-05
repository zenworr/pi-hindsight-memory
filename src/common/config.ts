import fs from "node:fs";
import path from "node:path";
import { absolutePath, defaultRuntimePaths, homeDirectory } from "./paths.js";
import type { AppConfig, HindsightConfig, Source } from "./types.js";
import { SOURCES } from "./types.js";

const DEFAULT_BANK = "coding-history";
const DEFAULT_API_URL = "http://127.0.0.1:8888";
const DEFAULT_UI_URL = "http://127.0.0.1:9999";

export function defaultConfig(home = homeDirectory()): AppConfig {
  const paths = defaultRuntimePaths(home);
  const useEnvironment = home === homeDirectory();
  const piAgentDirectory = useEnvironment && process.env.PI_CODING_AGENT_DIR ? absolutePath(process.env.PI_CODING_AGENT_DIR, home) : path.join(home, ".pi", "agent");
  const codexDirectory = useEnvironment && process.env.CODEX_HOME ? absolutePath(process.env.CODEX_HOME, home) : path.join(home, ".codex");
  const claudeDirectory = useEnvironment && process.env.CLAUDE_CONFIG_DIR ? absolutePath(process.env.CLAUDE_CONFIG_DIR, home) : path.join(home, ".claude");
  const dataDirectory = useEnvironment && process.env.XDG_DATA_HOME ? absolutePath(process.env.XDG_DATA_HOME, home) : path.join(home, ".local", "share");
  const opencodeDirectory = path.join(dataDirectory, "opencode");
  return {
    configPath: paths.configPath,
    stateDirectory: paths.stateDirectory,
    stateDatabase: paths.stateDatabase,
    evidenceDatabase: path.join(paths.stateDirectory, "evidence.sqlite3"),
    reviewedFactsFile: path.join(paths.configDirectory, "current-facts.json"),
    reportDirectory: paths.reportDirectory,
    spoolDirectory: paths.spoolDirectory,
    approvalFile: path.join(paths.configDirectory, "import-approval.json"),
    sessionExclusions: { exactLabels: [] },
    maxCanonicalBytes: 100 * 1024 * 1024,
    scanIntervalSeconds: 300,
    sessionSettleSeconds: 60,
    maxInflightDocuments: 4,
    requireImportApproval: true,
    sourceRoots: {
      pi: path.join(piAgentDirectory, "sessions"),
      codex: path.join(codexDirectory, "sessions"),
      claude: path.join(claudeDirectory, "projects"),
      opencode: opencodeDirectory,
    },
    codexStateDatabase: path.join(codexDirectory, "state_5.sqlite"),
    opencodeDatabase: path.join(opencodeDirectory, "opencode.db"),
    hindsight: {
      apiUrl: DEFAULT_API_URL,
      uiUrl: DEFAULT_UI_URL,
      environmentFile: paths.environmentPath,
      bankId: DEFAULT_BANK,
      apiTokenFile: paths.tokenPath,
      requestTimeoutMs: 15_000,
      dryRunTimeoutMs: 5 * 60 * 1000,
      retainWallTimeoutMs: 24 * 60 * 60 * 1000,
      recallMaxTokens: 2_500,
      recallChunksMaxTokens: 2_500,
      recallSourceFactsMaxTokens: 1_500,
      minRelevanceScore: 0.01,
      operationPollMs: 5_000,
      operationPollTimeoutMs: 60 * 60 * 1000,
      operationRetentionDays: 14,
    },
  };
}

function merge<T extends object>(base: T, override: Partial<T>): T {
  return { ...base, ...override } as T;
}

function assertPositiveNumber(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} number`);
  }
  return value;
}

function validateConfig(config: AppConfig): AppConfig {
  if (!config.hindsight.apiUrl.startsWith("http://") && !config.hindsight.apiUrl.startsWith("https://")) {
    throw new Error("hindsight.apiUrl must use http:// or https://");
  }
  if (config.hindsight.uiUrl && !config.hindsight.uiUrl.startsWith("http://") && !config.hindsight.uiUrl.startsWith("https://")) {
    throw new Error("hindsight.uiUrl must use http:// or https://");
  }
  if (!config.hindsight.bankId || /[\s/]/.test(config.hindsight.bankId)) {
    throw new Error("hindsight.bankId must be a non-empty URL-safe identifier");
  }
  if (!Array.isArray(config.sessionExclusions.exactLabels) || config.sessionExclusions.exactLabels.some((label) => typeof label !== "string" || !label.trim())) throw new Error("sessionExclusions.exactLabels must contain non-empty strings");
  assertPositiveNumber(config.maxCanonicalBytes, "maxCanonicalBytes");
  assertPositiveNumber(config.scanIntervalSeconds, "scanIntervalSeconds");
  assertPositiveNumber(config.sessionSettleSeconds, "sessionSettleSeconds", true);
  assertPositiveNumber(config.maxInflightDocuments, "maxInflightDocuments");
  assertPositiveNumber(config.hindsight.requestTimeoutMs, "hindsight.requestTimeoutMs");
  assertPositiveNumber(config.hindsight.retainWallTimeoutMs, "hindsight.retainWallTimeoutMs");
  assertPositiveNumber(config.hindsight.recallMaxTokens, "hindsight.recallMaxTokens", true);
  assertPositiveNumber(config.hindsight.recallChunksMaxTokens, "hindsight.recallChunksMaxTokens", true);
  assertPositiveNumber(config.hindsight.recallSourceFactsMaxTokens, "hindsight.recallSourceFactsMaxTokens", true);
  if (config.hindsight.minRelevanceScore !== undefined) assertPositiveNumber(config.hindsight.minRelevanceScore, "hindsight.minRelevanceScore", true);
  assertPositiveNumber(config.hindsight.operationPollMs, "hindsight.operationPollMs");
  assertPositiveNumber(config.hindsight.operationPollTimeoutMs, "hindsight.operationPollTimeoutMs");
  assertPositiveNumber(config.hindsight.operationRetentionDays, "hindsight.operationRetentionDays", true);
  return config;
}

export function loadConfig(configPath?: string, home = homeDirectory()): AppConfig {
  const defaults = defaultConfig(home);
  const selectedPath = configPath ? absolutePath(configPath, home) : process.env.PI_HINDSIGHT_CONFIG
    ? absolutePath(process.env.PI_HINDSIGHT_CONFIG, home)
    : defaults.configPath;
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(selectedPath)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(selectedPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid config object: ${selectedPath}`);
    fileConfig = parsed as Partial<AppConfig>;
  }
  const config: AppConfig = {
    ...defaults,
    ...fileConfig,
    configPath: selectedPath,
    sourceRoots: merge(defaults.sourceRoots, fileConfig.sourceRoots ?? {}),
    sessionExclusions: { ...defaults.sessionExclusions, ...(fileConfig.sessionExclusions ?? {}) },
    hindsight: merge(defaults.hindsight, fileConfig.hindsight ?? {}),
  };

  for (const source of SOURCES) config.sourceRoots[source] = absolutePath(config.sourceRoots[source], home);
  config.codexStateDatabase = absolutePath(config.codexStateDatabase, home);
  config.opencodeDatabase = absolutePath(config.opencodeDatabase, home);
  config.stateDirectory = absolutePath(config.stateDirectory, home);
  config.stateDatabase = absolutePath(config.stateDatabase, home);
  config.evidenceDatabase = absolutePath(config.evidenceDatabase, home);
  config.reviewedFactsFile = absolutePath(config.reviewedFactsFile, home);
  config.reportDirectory = absolutePath(config.reportDirectory, home);
  config.spoolDirectory = absolutePath(config.spoolDirectory, home);
  config.approvalFile = absolutePath(config.approvalFile, home);
  config.hindsight.environmentFile = absolutePath(config.hindsight.environmentFile, home);
  config.hindsight.apiTokenFile = absolutePath(config.hindsight.apiTokenFile, home);

  if (process.env.PI_HINDSIGHT_API_URL) config.hindsight.apiUrl = process.env.PI_HINDSIGHT_API_URL;
  if (process.env.PI_HINDSIGHT_UI_URL) config.hindsight.uiUrl = process.env.PI_HINDSIGHT_UI_URL;
  if (process.env.PI_HINDSIGHT_BANK_ID) config.hindsight.bankId = process.env.PI_HINDSIGHT_BANK_ID;
  if (process.env.PI_HINDSIGHT_API_TOKEN_FILE) config.hindsight.apiTokenFile = absolutePath(process.env.PI_HINDSIGHT_API_TOKEN_FILE, home);
  if (process.env.PI_HINDSIGHT_MAX_INFLIGHT) config.maxInflightDocuments = Number(process.env.PI_HINDSIGHT_MAX_INFLIGHT);
  if (process.env.PI_HINDSIGHT_SCAN_INTERVAL) config.scanIntervalSeconds = Number(process.env.PI_HINDSIGHT_SCAN_INTERVAL);
  if (process.env.PI_HINDSIGHT_SETTLE_SECONDS) config.sessionSettleSeconds = Number(process.env.PI_HINDSIGHT_SETTLE_SECONDS);
  if (process.env.PI_HINDSIGHT_REQUIRE_APPROVAL !== undefined) config.requireImportApproval = process.env.PI_HINDSIGHT_REQUIRE_APPROVAL !== "0";

  return validateConfig(config);
}

export function defaultHindsightConfig(): HindsightConfig {
  return defaultConfig().hindsight;
}

export function enabledSources(config: AppConfig): Source[] {
  return [...SOURCES].filter((source) => Boolean(config.sourceRoots[source]));
}
