import { statfs } from "node:fs/promises";
import type { AppConfig, CanonicalSession, CanonicalSessionMetadata, HindsightOperation, ImportApproval, SessionReference, Source } from "../common/types.js";
import { CANONICAL_SCHEMA, ADAPTER_VERSION, REDACTION_POLICY_VERSION } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import type { SessionAdapter } from "../adapters/adapter.js";
import { HindsightClient, HindsightHttpError, HindsightOperationError, HindsightPollTimeoutError } from "../hindsight/client.js";
import { errorMessage, Logger } from "../common/logging.js";
import { assertImportApproval, estimateCostUsd, estimateInputTokens, readApproval } from "../common/approval.js";
import { redactText } from "../canonical/redact.js";
import { Semaphore, sleep } from "./scheduler.js";
import type { GenerationRecord, SessionStateRecord } from "./state-db.js";
import { StateDatabase } from "./state-db.js";
import { configuredExclusion } from "./exclusions.js";
import { nextOperationId } from "./queue.js";
import { removeEvidence } from "./evidence.js";
import { loadPendingPayload, removePendingPayload, savePendingPayload } from "./pending-payload.js";

export interface WorkerSummary { selected: number; completed: number; failed: number; deferred: number; }
const TERMINAL_FAILURES = ["failed", "cancelled", "error", "rejected"];

export class ImportWorker {
  private readonly limiter: Semaphore;
  private readonly adapters: Map<Source, SessionAdapter>;
  private readonly logger: Logger;
  constructor(private readonly config: AppConfig, private readonly state: StateDatabase, private readonly client: HindsightClient, logger?: Logger, private readonly bulkMode = false, private readonly repairMode = false) {
    this.limiter = new Semaphore(config.maxInflightDocuments);
    this.adapters = new Map(createAdapters(config).map((adapter) => [adapter.source, adapter]));
    this.logger = logger ?? new Logger("import-worker");
  }

  async preflight(signal?: AbortSignal): Promise<ImportApproval | undefined> {
    if (!this.config.requireImportApproval) return undefined;
    const approval = assertImportApproval(this.config);
    await this.client.ensureBank(signal);
    await this.client.assertBankConfiguration({ requireExtraction: true, bulk: this.bulkMode, signal });
    await this.client.assertExtractionAvailable(signal);
    return approval;
  }

  async runOnce(limit = 100, signal?: AbortSignal): Promise<WorkerSummary> {
    const priority: Record<string, number> = { processing: 0, submitted: 0, queued: 1, failed: 2 };
    const candidates = this.state.listGenerations()
      .filter((generation) => ["queued", "submitted", "processing"].includes(generation.state) || generation.state === "failed" && generation.attemptCount < 3)
      .sort((a, b) => (priority[a.state] ?? 9) - (priority[b.state] ?? 9) || a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, limit);
    const summary: WorkerSummary = { selected: candidates.length, completed: 0, failed: 0, deferred: 0 };
    await Promise.all(candidates.map((generation) => this.limiter.run(async () => {
      if (signal?.aborted) { summary.deferred += 1; return; }
      const result = await this.process(generation, signal);
      summary[result] += 1;
    })));
    const approval = this.config.requireImportApproval ? readApproval(this.config.approvalFile) : undefined;
    if (approval?.maxFailureRate !== undefined && summary.selected > 0 && summary.failed / summary.selected > approval.maxFailureRate) throw new Error(`Import failure rate ${summary.failed}/${summary.selected} exceeded approved maximum ${approval.maxFailureRate}`);
    return summary;
  }

  async drain(maxMs = 60 * 60 * 1000, signal?: AbortSignal): Promise<WorkerSummary> {
    const started = Date.now();
    const total: WorkerSummary = { selected: 0, completed: 0, failed: 0, deferred: 0 };
    while (this.state.pendingWorkCount() > 0 && !signal?.aborted) {
      if (Date.now() - started >= maxMs) throw new Error(`Importer still has pending work after ${maxMs} ms`);
      const batch = await this.runOnce(Math.max(1000, this.config.maxInflightDocuments * 100), signal);
      total.selected += batch.selected; total.completed += batch.completed; total.failed += batch.failed; total.deferred += batch.deferred;
      if (batch.selected === 0) break;
      if (batch.completed === 0 && batch.failed === 0 && this.state.pendingWorkCount() > 0) {
        if (!this.state.listGenerations().some((generation) => ["submitted", "processing"].includes(generation.state))) throw new Error("Queued work is blocked; inspect session classification and cleanup state");
        await sleep(250, signal);
      }
    }
    return total;
  }

  private complete(generation: GenerationRecord, operation: HindsightOperation): void {
    const session = this.state.getSession(generation.source, generation.nativeSessionId)!;
    this.state.durableTransaction(() => {
      this.state.upsertOperation({ operationId: generation.operationId, documentId: session.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: "completed", lastPolledAt: new Date().toISOString(), retryCount: Math.max(0, generation.attemptCount - 1), responseSummary: JSON.stringify({ operation_id: generation.operationId, status: operation.status }) });
      this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "completed", { completedAt: new Date().toISOString() });
    });
    this.logger.info("Imported session", { source: generation.source, session: generation.nativeSessionId });
  }

  private async cleanupPayload(operationId: string): Promise<void> {
    await removePendingPayload(this.config.spoolDirectory, operationId).catch(() => {
      this.logger.warn("Completed operation payload could not be removed", { operation: operationId });
    });
  }

  private async process(generation: GenerationRecord, shutdownSignal?: AbortSignal): Promise<"completed" | "failed" | "deferred"> {
    if (generation.state === "failed" && generation.attemptCount >= 3) return "deferred";
    if (!this.state.claimGeneration(generation)) return "deferred";
    generation = this.state.getGeneration(generation.source, generation.nativeSessionId, generation.canonicalHash)!;
    const sessionState = this.state.getSession(generation.source, generation.nativeSessionId)!;
    let session: CanonicalSession | undefined;
    let previousPayloadId: string | undefined;
    let persisted = this.state.getOperation(generation.operationId);
    if (generation.repair && !persisted && sessionState.acknowledgedPolicy === generation.retainPolicyVersion) {
      generation = { ...generation, repair: false };
      this.state.upsertGeneration(generation);
    }
    const deadlineSignal = AbortSignal.timeout(this.config.hindsight.retainWallTimeoutMs);
    const operationSignal = shutdownSignal ? AbortSignal.any([shutdownSignal, deadlineSignal]) : deadlineSignal;
    try {
      operationSignal.throwIfAborted();
      if (persisted && TERMINAL_FAILURES.includes(persisted.hindsightStatus ?? "")) {
        session = await loadPendingPayload(this.config.spoolDirectory, generation.operationId, generation.canonicalHash);
        previousPayloadId = session ? generation.operationId : undefined;
        generation = { ...generation, operationId: nextOperationId(this.state, this.config.hindsight.bankId, sessionState.documentId, generation.canonicalHash, generation.operationId), submittedAt: undefined, completedAt: undefined };
        persisted = undefined;
      }
      // A submitted payload belongs to the operation, not to the source file's current contents.
      if (persisted && !["prepared", "ready"].includes(persisted.hindsightStatus ?? "")) {
        try {
          const operation = await this.client.waitForOperation(generation.operationId, operationSignal, Math.min(30_000, this.config.hindsight.retainWallTimeoutMs));
          this.complete(generation, operation);
          await this.cleanupPayload(generation.operationId);
          return "completed";
        } catch (error) {
          if (!(error instanceof HindsightHttpError) || error.status !== 404) throw error;
        }
      }
      if (persisted) session = await loadPendingPayload(this.config.spoolDirectory, generation.operationId, generation.canonicalHash);
      const adapter = this.adapters.get(generation.source);
      if (!adapter) throw new Error(`No adapter for ${generation.source}`);
      const reference = referenceFromState(sessionState);
      let structuralClassification;
      try { structuralClassification = await adapter.classify(reference); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || session?.classification?.kind !== "primary") throw error;
        structuralClassification = session.classification;
      }
      if (structuralClassification.reason === "opencode-session-disappeared-during-classification" && session?.classification?.kind === "primary") structuralClassification = session.classification;
      const tombstone = this.state.getExclusionTombstone(generation.source, generation.nativeSessionId, sessionState.documentId);
      const currentClassification = configuredExclusion(structuralClassification.label, this.config.sessionExclusions) ?? (tombstone ? { kind: "configured-exclusion" as const, reason: "persisted-configured-exclusion", policyVersion: structuralClassification.policyVersion, label: tombstone.label } : structuralClassification);
      if (currentClassification.kind !== "primary") {
        removeEvidence(this.config, sessionState.documentId);
        if (currentClassification.kind === "configured-exclusion" && currentClassification.label) this.state.recordExclusionTombstone({ source: generation.source, nativeSessionId: generation.nativeSessionId, documentId: sessionState.documentId, locator: sessionState.sourceLocator, label: currentClassification.label, normalizedLabel: currentClassification.label.normalize("NFKC").trim().toLowerCase(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        if (currentClassification.kind === "ambiguous" && sessionState.acknowledgedHash && !persisted) {
          this.state.setSessionClassification(generation.source, generation.nativeSessionId, currentClassification, "ambiguous_preserved");
          this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "superseded");
        } else {
          const status = currentClassification.kind === "subagent" ? "excluded_subagent" : currentClassification.kind === "configured-exclusion" ? "excluded_configured" : "excluded_ambiguous";
          this.state.setSessionClassification(generation.source, generation.nativeSessionId, currentClassification, status);
          this.state.markSessionGenerationsCleanupPending(generation.source, generation.nativeSessionId, `Classification changed before retain: ${currentClassification.reason}`);
        }
        return "deferred";
      }
      if (!session) {
        session = await adapter.load(reference, { spoolDirectory: this.config.spoolDirectory, maxCanonicalBytes: this.config.maxCanonicalBytes, signal: operationSignal });
        operationSignal.throwIfAborted();
        if (session.canonicalHash !== generation.canonicalHash) {
          if (persisted) throw new Error("Submitted source changed and its immutable payload is unavailable; remote reconciliation is required");
          this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "superseded", { error: "Source changed before submission" });
          return "deferred";
        }
      }
      if (session.emptyAfterNormalization) throw new Error("Refusing to retain an empty generation");
      if (session.metadata.redaction_policy_version !== REDACTION_POLICY_VERSION) throw new Error("Pending payload uses an older redaction policy; reconcile it before submitting new work");
      const approval = await this.preflight(operationSignal);
      if (approval) {
        if (approval.minFreeBytes !== undefined) {
          const filesystem = await statfs(this.config.stateDirectory);
          if (Number(filesystem.bavail) * Number(filesystem.bsize) < approval.minFreeBytes) throw new Error("Free disk space is below the approved minimum");
        }
        const inputTokens = estimateInputTokens(session.canonicalBytes);
        if (!this.state.reserveBudget(generation.operationId, inputTokens, estimateCostUsd(inputTokens, approval), approval.maxEstimatedInputTokens, approval.maxEstimatedCostUsd)) throw new Error("Approved import budget exceeded; review the approval before retrying");
      }
      await this.client.ensureBank(operationSignal);
      await this.client.assertBankConfiguration({ requireExtraction: true, bulk: this.bulkMode, signal: operationSignal });
      await this.client.assertExtractionAvailable(operationSignal);
      if (generation.repair && !this.repairMode) throw new Error("Historical evidence-policy repair requires a reviewed plan-repair/repair command");
      if (!persisted) {
        await savePendingPayload(this.config.spoolDirectory, generation.operationId, session);
        this.state.durableTransaction(() => {
          this.state.upsertGeneration(generation);
          this.state.upsertOperation({ operationId: generation.operationId, documentId: session!.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: "prepared", retryCount: 0 });
        });
        persisted = this.state.getOperation(generation.operationId)!;
        if (previousPayloadId) {
          session = await loadPendingPayload(this.config.spoolDirectory, generation.operationId, generation.canonicalHash);
          if (!session) throw new Error("Retry payload is unavailable");
          await this.cleanupPayload(previousPayloadId);
        }
      }
      if (persisted.hindsightStatus === "prepared") {
        if (generation.repair) {
          const remote = await this.client.getDocument(session.documentId, operationSignal);
          if (remote && ![sessionState.acknowledgedHash, generation.canonicalHash].includes(remote.content_hash)) throw new Error("Remote document changed outside the reviewed repair generation");
          if (remote) {
            try { await this.client.deleteDocument(session.documentId, operationSignal); }
            catch (error) { if (!(error instanceof HindsightHttpError) || error.status !== 404) throw error; }
          }
        }
        this.state.durableTransaction(() => this.state.upsertOperation({ ...persisted!, hindsightStatus: "ready" }));
      }
      this.state.durableTransaction(() => {
        this.state.upsertOperation({ ...persisted!, hindsightStatus: "submitting", submittedAt: new Date().toISOString() });
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { submittedAt: new Date().toISOString() });
      });
      const response = await this.client.retainWithOperationId(session, generation.operationId, operationSignal);
      if (response.operation_id && response.operation_id !== generation.operationId) throw new Error("Hindsight did not honor the requested operation identifier");
      this.state.upsertOperation({ ...persisted, hindsightStatus: "pending", submittedAt: new Date().toISOString() });
      const operation = await this.client.waitForOperation(generation.operationId, operationSignal, Math.min(30_000, this.config.hindsight.retainWallTimeoutMs));
      this.complete(generation, operation);
      await this.cleanupPayload(generation.operationId);
      return "completed";
    } catch (error) {
      if (shutdownSignal?.aborted) {
        this.logger.info("Session import interrupted by shutdown", { source: generation.source, session: generation.nativeSessionId });
        return "deferred";
      }
      const operation = this.state.getOperation(generation.operationId);
      const message = redactText(errorMessage(error)).text.slice(0, 1000);
      const rejected = error instanceof HindsightHttpError && error.method === "POST" && error.status >= 400 && error.status < 500 && ![408,409,425,429].includes(error.status);
      const terminal = error instanceof HindsightOperationError || rejected;
      if (operation && !terminal) {
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { error: error instanceof HindsightPollTimeoutError ? undefined : message });
        return "deferred";
      }
      this.state.durableTransaction(() => {
        if (operation) this.state.upsertOperation({ ...operation, hindsightStatus: error instanceof HindsightOperationError ? error.status : "rejected", lastPolledAt: new Date().toISOString() });
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "failed", { error: message });
      });
      this.logger.error("Session import failed", { source: generation.source, session: generation.nativeSessionId, error: message });
      return "failed";
    } finally { if (session) await session.cleanup().catch(() => undefined); }
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
  return { source: record.source, nativeSessionId: record.nativeSessionId, locator: record.sourceLocator, sourcePath: record.sourceLocator, sessionStartedAt: record.sessionStartedAt, sessionUpdatedAt: record.sessionUpdatedAt, metadata };
}
