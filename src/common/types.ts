export const SOURCES = ["pi", "codex", "claude", "opencode"] as const;
export type Source = (typeof SOURCES)[number];

export const CANONICAL_SCHEMA = "agent-session-v1" as const;
export const ADAPTER_VERSION = "0.2.0" as const;
export const REDACTION_POLICY_VERSION = "3" as const;
export const CLASSIFICATION_POLICY_VERSION = "3" as const;
export const RETAIN_POLICY_VERSION = "2" as const;

export type CanonicalRole = "system" | "user" | "assistant" | "action";
export type Provenance = "original" | "memory-assisted";
export type SessionClassificationKind = "primary" | "subagent" | "ambiguous" | "configured-exclusion";

export interface SessionClassification {
  kind: SessionClassificationKind;
  reason: string;
  policyVersion: string;
  label?: string;
  parentSessionId?: string;
}

export interface CanonicalTurn {
  role: CanonicalRole;
  content: string;
  timestamp: string;
  native_entry_id?: string;
  parent_entry_id?: string;
  provenance?: Provenance;
}

export interface CanonicalSessionMetadata {
  source: string;
  native_session_id: string;
  source_path: string;
  cwd?: string;
  title?: string;
  parent_session_id?: string;
  project_id?: string;
  agent?: string;
  model?: string;
  canonical_schema: string;
  adapter_version: string;
  redaction_policy_version: string;
  source_missing?: string;
}

export interface CanonicalSession {
  source: Source;
  nativeSessionId: string;
  documentId: string;
  sourceLocator: string;
  metadata: CanonicalSessionMetadata;
  sessionStartedAt: string;
  sessionUpdatedAt: string;
  canonicalHash: string;
  canonicalBytes: number;
  canonicalTurns: number;
  redactionCount: number;
  emptyAfterNormalization: boolean;
  classification?: SessionClassification;
  sessionLabel?: string;
  contentPath: string;
  readContent(maxBytes?: number): Promise<string>;
  cleanup(): Promise<void>;
}

export interface SessionReference {
  source: Source;
  nativeSessionId: string;
  locator: string;
  sourcePath?: string;
  sessionStartedAt?: string;
  sessionUpdatedAt?: string;
  metadata: CanonicalSessionMetadata;
  identityIsFallback?: boolean;
  classification?: SessionClassification;
  sessionLabel?: string;
}

export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  sampleHash: string;
  stableLocator: string;
  processing_signature?: string;
}

export interface AdapterLoadOptions {
  signal?: AbortSignal;
  spoolDirectory: string;
  maxCanonicalBytes: number;
  persistedFallbackTimestamp?: string;
}

export interface ScanCursor {
  watermark?: string;
}

export interface InventorySessionResult {
  source: Source;
  nativeSessionId: string;
  locator: string;
  status: "eligible" | "active" | "empty_after_normalization" | "excluded_subagent" | "excluded_configured" | "ambiguous" | "malformed" | "too_large" | "error";
  sourceBytes?: number;
  canonicalBytes?: number;
  canonicalTurns?: number;
  redactionCount?: number;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface InventoryReport {
  generatedAt: string;
  durationMs: number;
  parserVersion: string;
  canonicalSchema: string;
  redactionPolicyVersion: string;
  totals: {
    discovered: number;
    eligible: number;
    empty: number;
    subagents: number;
    configured: number;
    ambiguous: number;
    malformed: number;
    tooLarge: number;
    errors: number;
    sourceBytes: number;
    canonicalBytes: number;
    canonicalTurns: number;
    redactions: number;
  };
  bySource: Record<Source, {
    discovered: number;
    eligible: number;
    empty: number;
    subagents: number;
    configured: number;
    ambiguous: number;
    malformed: number;
    tooLarge: number;
    errors: number;
    sourceBytes: number;
    canonicalBytes: number;
    canonicalTurns: number;
    redactions: number;
  }>;
  largestCanonical: Array<{
    source: Source;
    nativeSessionId: string;
    canonicalBytes: number;
    sourceBytes: number;
  }>;
  missingIdentifiers: number;
  missingTimestamps: number;
  results?: InventorySessionResult[];
}

export interface SessionExclusionConfig {
  exactLabels: string[];
}

export interface AppConfig {
  configPath: string;
  stateDirectory: string;
  stateDatabase: string;
  evidenceDatabase: string;
  reviewedFactsFile: string;
  reportDirectory: string;
  spoolDirectory: string;
  approvalFile: string;
  sessionExclusions: SessionExclusionConfig;
  maxCanonicalBytes: number;
  scanIntervalSeconds: number;
  sessionSettleSeconds: number;
  maxInflightDocuments: number;
  requireImportApproval: boolean;
  sourceRoots: {
    pi: string;
    codex: string;
    claude: string;
    opencode: string;
  };
  codexStateDatabase: string;
  opencodeDatabase: string;
  hindsight: HindsightConfig;
}

export interface HindsightConfig {
  apiUrl: string;
  uiUrl?: string;
  environmentFile: string;
  bankId: string;
  apiTokenFile: string;
  requestTimeoutMs: number;
  dryRunTimeoutMs?: number;
  retainWallTimeoutMs: number;
  recallMaxTokens: number;
  recallChunksMaxTokens: number;
  recallSourceFactsMaxTokens: number;
  minRelevanceScore?: number;
  operationPollMs: number;
  operationPollTimeoutMs: number;
  operationRetentionDays: number;
}

export type GenerationState = "discovered" | "queued" | "submitted" | "processing" | "completed" | "failed" | "cleanup_pending" | "excluded" | "superseded";

export interface RecallResult {
  id?: string;
  text?: string;
  type?: string;
  context?: string | null;
  metadata?: Record<string, string> | null;
  tags?: string[];
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  document_id?: string | null;
  chunk_id?: string | null;
  source_fact_ids?: string[] | null;
  scores?: {
    final?: number | null;
    reranker?: number | null;
    semantic?: number | null;
    keyword?: number | null;
  } | null;
}

export interface RecallResponse {
  results?: RecallResult[];
  source_facts?: Record<string, RecallResult>;
  source_facts_truncated?: boolean;
  chunks?: Record<string, { id?: string; text?: string; chunk_index?: number; truncated?: boolean }>;
}

export interface HindsightBankStats {
  total_documents?: number;
  pending_consolidation?: number;
  failed_consolidation?: number;
  pending_operations?: number;
  failed_operations?: number;
  operations_by_status?: Record<string, number>;
}

export interface HindsightOperation {
  operation_id?: string;
  id?: string;
  status?: string;
  operation_type?: string;
  task_type?: string;
  error_message?: string | null;
  progress?: Record<string, unknown> | null;
  result_metadata?: Record<string, unknown> | null;
}

export interface HindsightBankConfigResponse {
  config?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

export interface HindsightVersionResponse {
  api_version?: string;
  features?: Record<string, unknown>;
}

export type ImportPrivacyMode = "remote-redacted" | "local";

export interface ImportApproval {
  approvedAt: string;
  provider: string;
  model: string;
  retainModel?: string;
  consolidationModel?: string;
  privacy: ImportPrivacyMode;
  maxEstimatedInputTokens: number;
  maxEstimatedCostUsd: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  outputTokenMultiplier?: number;
  minFreeBytes?: number;
  maxFailureRate?: number;
}
