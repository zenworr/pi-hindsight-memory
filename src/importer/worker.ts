import { statfs } from "node:fs/promises";
import type { AppConfig, CanonicalSessionMetadata, HindsightOperation, ImportApproval, SessionReference, Source } from "../common/types.js";
import { CANONICAL_SCHEMA, ADAPTER_VERSION, REDACTION_POLICY_VERSION } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import type { SessionAdapter } from "../adapters/adapter.js";
import { HindsightClient, HindsightHttpError } from "../hindsight/client.js";
import { errorMessage, Logger } from "../common/logging.js";
import { assertImportApproval, estimateCostUsd, estimateInputTokens } from "../common/approval.js";
import { Semaphore } from "./scheduler.js";
import type { GenerationRecord, SessionStateRecord } from "./state-db.js";
import { StateDatabase } from "./state-db.js";
import { configuredExclusion } from "./exclusions.js";

export interface WorkerSummary { selected: number; completed: number; failed: number; deferred: number; }

export class ImportWorker {
  private readonly limiter: Semaphore;
  private readonly adapters: Map<Source, SessionAdapter>;
  private readonly logger: Logger;
  constructor(private readonly config: AppConfig, private readonly state: StateDatabase, private readonly client: HindsightClient, logger?: Logger, private readonly bulkMode = false) {
    this.limiter = new Semaphore(config.maxInflightDocuments);
    this.adapters = new Map(createAdapters(config).map((adapter) => [adapter.source, adapter]));
    this.logger = logger ?? new Logger("import-worker");
  }

  async preflight(): Promise<ImportApproval | undefined> {
    if (!this.config.requireImportApproval) return undefined;
    const approval = assertImportApproval(this.config);
    await this.client.ensureBank();
    await this.client.assertBankConfiguration({ requireExtraction: true, bulk: this.bulkMode });
    await this.client.assertExtractionAvailable();
    return approval;
  }

  async runOnce(limit = 100): Promise<WorkerSummary> {
    const priority: Record<string, number> = { processing: 0, submitted: 0, queued: 1, failed: 2 };
    const candidates = [...this.state.listGenerations()]
      .filter((generation) => ["queued", "submitted", "processing"].includes(generation.state) || generation.state === "failed" && generation.attemptCount < 3)
      .sort((a, b) => (priority[a.state] ?? 9) - (priority[b.state] ?? 9) || a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, limit);
    if (candidates.length === 0) return { selected: 0, completed: 0, failed: 0, deferred: 0 };
    const approval = await this.preflight();
    const summary: WorkerSummary = { selected: candidates.length, completed: 0, failed: 0, deferred: 0 };
    await Promise.all(candidates.map((generation) => this.limiter.run(async () => {
      const result = await this.process(generation, approval);
      if (result === "completed") summary.completed += 1;
      else if (result === "failed") summary.failed += 1;
      else summary.deferred += 1;
    })));
    if (approval?.maxFailureRate !== undefined && summary.selected > 0 && summary.failed / summary.selected > approval.maxFailureRate) throw new Error(`Import failure rate ${summary.failed}/${summary.selected} exceeded approved maximum ${approval.maxFailureRate}`);
    return summary;
  }

  async drain(maxMs = 60 * 60 * 1000): Promise<WorkerSummary> {
    const started = Date.now();
    const total: WorkerSummary = { selected: 0, completed: 0, failed: 0, deferred: 0 };
    while (Date.now() - started < maxMs) {
      const before = this.state.listGenerations().filter((generation) => ["queued", "submitted", "processing"].includes(generation.state)).length;
      if (before === 0) break;
      const batch = await this.runOnce(Math.max(1000, this.config.maxInflightDocuments * 100));
      total.selected += batch.selected; total.completed += batch.completed; total.failed += batch.failed; total.deferred += batch.deferred;
      const after = this.state.listGenerations().filter((generation) => ["queued", "submitted", "processing"].includes(generation.state)).length;
      if (batch.selected === 0 || (batch.completed === 0 && batch.failed === 0) || after >= before && batch.deferred === batch.selected) break;
    }
    return total;
  }

  private async process(generation: GenerationRecord, approval?: ImportApproval): Promise<"completed" | "failed" | "deferred"> {
    if (generation.state === "failed" && generation.attemptCount >= 3) return "deferred";
    if (!this.state.claimGeneration(generation)) return "deferred";
    const claimed = this.state.getGeneration(generation.source, generation.nativeSessionId, generation.canonicalHash) ?? generation;
    const sessionState = this.state.getSession(generation.source, generation.nativeSessionId);
    if (!sessionState) {
      this.markFailure(generation, "Session state is missing");
      return "failed";
    }
    const adapter = this.adapters.get(generation.source);
    if (!adapter) { this.markFailure(generation, `No adapter for ${generation.source}`); return "failed"; }
    const reference = referenceFromState(sessionState);
    let session;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), this.config.hindsight.retainWallTimeoutMs);
    try {
      const structuralClassification = await adapter.classify(reference);
      const currentClassification = configuredExclusion(structuralClassification.label, this.config.sessionExclusions) ?? structuralClassification;
      if (currentClassification.kind !== "primary") {
        if (currentClassification.kind === "configured-exclusion" && currentClassification.label) {
          this.state.recordExclusionTombstone({ source: generation.source, nativeSessionId: generation.nativeSessionId, documentId: sessionState.documentId, locator: sessionState.sourceLocator, label: currentClassification.label, normalizedLabel: currentClassification.label.normalize("NFKC").trim().toLowerCase(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
        const excludedStatus = currentClassification.kind === "subagent" ? "excluded_subagent" : currentClassification.kind === "configured-exclusion" ? "excluded_configured" : "excluded_ambiguous";
        this.state.setSessionClassification(generation.source, generation.nativeSessionId, currentClassification, excludedStatus);
        this.state.markSessionGenerationsCleanupPending(generation.source, generation.nativeSessionId, `Classification changed before retain: ${currentClassification.reason}`);
        return "deferred";
      }
      session = await adapter.load(reference, { spoolDirectory: this.config.spoolDirectory, maxCanonicalBytes: this.config.maxCanonicalBytes });
      if (session.canonicalHash !== generation.canonicalHash) {
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "superseded", { error: "Source changed before this generation was submitted" });
        await session.cleanup();
        return "deferred";
      }
      if (session.emptyAfterNormalization) {
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "completed", { completedAt: new Date().toISOString() });
        await session.cleanup();
        return "completed";
      }
      if (approval) {
        if (approval.minFreeBytes !== undefined) {
          const filesystem = await statfs(this.config.stateDirectory);
          const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
          if (freeBytes < approval.minFreeBytes) {
            this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "failed", { attemptCount: claimed.attemptCount, error: `Free disk space ${freeBytes} is below approved minimum ${approval.minFreeBytes}` });
            await session.cleanup();
            return "failed";
          }
        }
        const inputTokens = estimateInputTokens(session.canonicalBytes);
        const estimatedCost = estimateCostUsd(inputTokens, approval);
        if (!this.state.reserveBudget(generation.operationId, inputTokens, estimatedCost, approval.maxEstimatedInputTokens, approval.maxEstimatedCostUsd)) {
          this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "failed", { attemptCount: claimed.attemptCount, error: "Approved import budget exceeded; increase the approval and run retry-failed" });
          await session.cleanup();
          return "failed";
        }
      }
      const attemptCount = Math.max(generation.attemptCount, claimed.attemptCount);
      let operation: HindsightOperation | undefined;
      const persistedOperation = this.state.getOperation(generation.operationId);
      if (persistedOperation) {
        try { operation = await this.client.waitForOperation(generation.operationId, deadlineController.signal, this.config.hindsight.retainWallTimeoutMs); }
        catch (error) {
          if (!(error instanceof HindsightHttpError) || error.status !== 404) throw error;
        }
      }
      if (!operation) {
        this.state.upsertOperation({ operationId: generation.operationId, documentId: session.documentId, canonicalHash: generation.canonicalHash, retryCount: Math.max(0, attemptCount - 1), submittedAt: new Date().toISOString() });
        await this.client.ensureBank(deadlineController.signal);
        await this.client.assertBankConfiguration({ requireExtraction: true, bulk: this.bulkMode, signal: deadlineController.signal });
        await this.client.assertExtractionAvailable(deadlineController.signal);
        const response = await this.client.retainWithOperationId(session, generation.operationId, deadlineController.signal);
        if (response.operation_id && response.operation_id !== generation.operationId) throw new Error(`Hindsight ignored requested operation_id ${generation.operationId} and returned ${response.operation_id}`);
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { submittedAt: new Date().toISOString(), attemptCount });
        this.state.upsertOperation({ operationId: generation.operationId, documentId: session.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: "pending", submittedAt: new Date().toISOString(), retryCount: Math.max(0, attemptCount - 1), responseSummary: JSON.stringify({ operation_id: generation.operationId, items_count: response.items_count ?? null }) });
        operation = await this.client.waitForOperation(generation.operationId, deadlineController.signal, this.config.hindsight.retainWallTimeoutMs);
      }
      this.state.upsertOperation({ operationId: generation.operationId, documentId: session.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: String(operation.status ?? "completed"), lastPolledAt: new Date().toISOString(), retryCount: Math.max(0, attemptCount - 1), responseSummary: JSON.stringify({ operation_id: generation.operationId, status: operation.status ?? "completed", result_metadata: operation.result_metadata ?? null }) });
      this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "completed", { completedAt: new Date().toISOString(), attemptCount });
      this.state.updateSessionCanonical(generation.source, generation.nativeSessionId, generation.canonicalHash, session.canonicalBytes, session.canonicalTurns, CANONICAL_SCHEMA, session.sessionStartedAt, session.sessionUpdatedAt, "imported");
      this.logger.info("Imported session", { source: generation.source, session: generation.nativeSessionId, bytes: session.canonicalBytes, turns: session.canonicalTurns });
      await session.cleanup();
      return "completed";
    } catch (error) {
      const message = errorMessage(error);
      this.markFailure(generation, message);
      this.logger.error("Session import failed", { source: generation.source, session: generation.nativeSessionId, error: message });
      if (session) await session.cleanup().catch(() => undefined);
      return "failed";
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private markFailure(generation: GenerationRecord, error: string): void {
    const attemptCount = generation.attemptCount + 1;
    this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "failed", { attemptCount, error });
  }
}

function referenceFromState(record: SessionStateRecord): SessionReference {
  const metadata: CanonicalSessionMetadata = {
    source: record.source,
    native_session_id: record.nativeSessionId,
    source_path: record.sourceLocator,
    canonical_schema: record.canonicalSchema ?? CANONICAL_SCHEMA,
    adapter_version: ADAPTER_VERSION,
    redaction_policy_version: REDACTION_POLICY_VERSION,
  };
  return {
    source: record.source,
    nativeSessionId: record.nativeSessionId,
    locator: record.sourceLocator,
    sourcePath: record.sourceLocator,
    sessionStartedAt: record.sessionStartedAt,
    sessionUpdatedAt: record.sessionUpdatedAt,
    metadata,
  };
}
