import fs from "node:fs";
import path from "node:path";
import { absolutePath, defaultRuntimePaths, homeDirectory } from "./paths.js";
import type { AppConfig } from "./types.js";
import { SOURCES } from "./types.js";
import { DEFAULT_DESKTOP_FEED_MAX_AGE_SECONDS, DEFAULT_MAX_CANONICAL_BYTES, DAY_MS, HOUR_MS } from "./limits.js";
import { validateConfig, validateOverrides } from "./config-validation.js";

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
    localOrigin: "desktop",
    desktopFeed: { enabled: false, directory: path.join(paths.stateDirectory, "desktop-feed", "current"), sourceHome: home, maxAgeSeconds: DEFAULT_DESKTOP_FEED_MAX_AGE_SECONDS },
    promotedSessions: { pi: [], codex: [], claude: [], opencode: [] },
    stateDirectory: paths.stateDirectory,
    stateDatabase: paths.stateDatabase,
    evidenceDatabase: path.join(paths.stateDirectory, "evidence.sqlite3"),
    reviewedFactsFile: path.join(paths.configDirectory, "current-facts.json"),
    reportDirectory: paths.reportDirectory,
    spoolDirectory: paths.spoolDirectory,
    approvalFile: path.join(paths.configDirectory, "import-approval.json"),
    sessionExclusions: { exactLabels: [] },
    maxCanonicalBytes: DEFAULT_MAX_CANONICAL_BYTES,
    scanIntervalSeconds: 900,
    sessionSettleSeconds: 3600,
    maxInflightDocuments: 4,
    importer: { retryDelayMs: 30_000, maxAttempts: 3, workBatchSize: 1_000 },
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
      statusTimeoutMs: 4_000,
      httpMaxAttempts: 3,
      httpRetryDelayMs: 100,
      httpMaxRetryDelayMs: 10_000,
      dryRunTimeoutMs: 300_000,
      retainWallTimeoutMs: DAY_MS,
      recallMaxTokens: 2_500,
      recallChunksMaxTokens: 2_500,
      recallSourceFactsMaxTokens: 1_500,
      minRelevanceScore: 0.01,
      operationPollMs: 5_000,
      operationPollTimeoutMs: HOUR_MS,
      operationRetentionDays: 14,
    },
  };
}

function merge<T extends object>(base: T, override: Partial<T>): T {
  return { ...base, ...override };
}

export function loadConfig(configPath?: string, home = homeDirectory()): AppConfig {
  const defaults = defaultConfig(home);
  const selectedPath = configPath ? absolutePath(configPath, home) : process.env.PI_HINDSIGHT_CONFIG
    ? absolutePath(process.env.PI_HINDSIGHT_CONFIG, home)
    : defaults.configPath;
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(selectedPath)) {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(selectedPath, "utf8")); }
    catch { throw new Error(`Cannot read config JSON: ${selectedPath}`); }
    validateOverrides(parsed, defaults);
    fileConfig = parsed;
  } else if (configPath || process.env.PI_HINDSIGHT_CONFIG) {
    throw new Error(`Config file not found: ${selectedPath}`);
  }
  const config: AppConfig = {
    ...defaults,
    ...fileConfig,
    configPath: selectedPath,
    importer: merge(defaults.importer, fileConfig.importer ?? {}),
    desktopFeed: merge(defaults.desktopFeed, fileConfig.desktopFeed ?? {}),
    promotedSessions: merge(defaults.promotedSessions, fileConfig.promotedSessions ?? {}),
    sourceRoots: merge(defaults.sourceRoots, fileConfig.sourceRoots ?? {}),
    sessionExclusions: { ...defaults.sessionExclusions, ...(fileConfig.sessionExclusions ?? {}) },
    hindsight: merge(defaults.hindsight, fileConfig.hindsight ?? {}),
  };

  for (const source of SOURCES) config.sourceRoots[source] = absolutePath(config.sourceRoots[source], home);
  config.codexStateDatabase = absolutePath(config.codexStateDatabase, home);
  config.opencodeDatabase = absolutePath(config.opencodeDatabase, home);
  config.desktopFeed.directory = absolutePath(config.desktopFeed.directory, home);
  config.desktopFeed.sourceHome = absolutePath(config.desktopFeed.sourceHome, home);
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
  if (process.env.PI_HINDSIGHT_REQUIRE_APPROVAL !== undefined) {
    if (!["0", "1"].includes(process.env.PI_HINDSIGHT_REQUIRE_APPROVAL)) throw new Error("PI_HINDSIGHT_REQUIRE_APPROVAL must be 0 or 1");
    config.requireImportApproval = process.env.PI_HINDSIGHT_REQUIRE_APPROVAL === "1";
  }

  return validateConfig(config);
}
