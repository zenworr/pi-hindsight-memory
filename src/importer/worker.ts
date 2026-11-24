import { BLOCK_ACTIONS, importFreeBytes } from "./admission.js";
import { SpanKind } from "@opentelemetry/api";
import { inSpan, telemetryCount, telemetryQueueWait } from "../common/telemetry.js";
import { HTTP_STATUS, isRetryableStatus } from "../hindsight/http.js";
import type { AppConfig, CanonicalSession, CanonicalSessionMetadata, ImportApproval, ImportBlockReason, SessionReference } from "../common/types.js";
import { CANONICAL_SCHEMA, ADAPTER_VERSION, REDACTION_POLICY_VERSION } from "../common/types.js";
import { createAdapters } from "../adapters/index.js";
import type { HindsightClient} from "../hindsight/client.js";
import { HindsightBankPolicyError, HindsightHttpError, HindsightOperationError, HindsightOperationNotFoundError, HindsightPollTimeoutError, HindsightRequestNotSentError, HindsightUnresolvedOperationError } from "../hindsight/client.js";
import { errorMessage, Logger } from "../common/logging.js";
import { assertImportApproval, estimateCostUsd, estimateInputTokens, ImportApprovalError } from "../common/approval.js";
import { redactText } from "../canonical/redact.js";
import { Semaphore } from "./scheduler.js";
import { sleep } from "../common/async.js";
import { ERROR_MESSAGE_MAX_CHARS, MS_PER_SECOND } from "../common/limits.js";
import type { GenerationRecord, ImportBlock, SessionStateRecord, StateDatabase } from "./state-db.js";
import { canPollOperation, TERMINAL_OPERATION_FAILURES, UNRESOLVED_SUBMISSION } from "./state-db.js";
import { configuredExclusion } from "./exclusions.js";
import { nextOperationId } from "./queue.js";
import { removeEvidence } from "./evidence.js";
import { loadPendingPayload, PendingPayloadIntegrityError, removePendingPayload, savePendingPayload, StaleRedactionPayloadError } from "./pending-payload.js";

type Block = Omit<ImportBlock, "since">;
type Admission = { approval?: ImportApproval; blocked?: never } | { blocked: Block; approval?: never };
type WorkOutcome = "completed" | "failed" | "deferred" | Block;
export interface WorkerSummary { selected: number; completed: number; failed: number; deferred: number; blocked?: Block; }

export class ImportFailureRateError extends Error {
  constructor(readonly summary: WorkerSummary, maxFailureRate: number) {
    super(`Import failure rate ${summary.failed}/${summary.selected} exceeded approved maximum ${maxFailureRate}`);
  }
}

class AdmissionError extends Error {
  constructor(readonly reason: ImportBlockReason, message: string, cause?: unknown) { super(message, { cause }); }
}

function importBlock(reason: ImportBlockReason): Block { return { reason, action: BLOCK_ACTIONS[reason] }; }
const OPERATION_POLL_SLICE_MS = 30_000;
const BLOCKED_QUEUE_RETRY_MS = 250;

export class ImportWorker {
  private readonly limiter: Semaphore;
  private readonly logger: Logger;
  constructor(private readonly config: AppConfig, private readonly state: StateDatabase, private readonly client: HindsightClient, logger?: Logger, private readonly bulkMode = false, private readonly repairMode = false) {
    this.limiter = new Semaphore(config.maxInflightDocuments);
    this.logger = logger ?? new Logger("import-worker");
  }

  private async localApproval(): Promise<ImportApproval | undefined> {
    let approval: ImportApproval | undefined;
    try { if (this.config.requireImportApproval) approval = assertImportApproval(this.config); }
    catch (error) { throw new AdmissionError(error instanceof ImportApprovalError ? error.reason : "approval-invalid", errorMessage(error), error); }
    if (approval?.minFreeBytes !== undefined) {
      let available: number;
      try { available = await importFreeBytes(this.config, this.state.databasePath); }
      catch (error) { throw new AdmissionError("disk-below-minimum", "Cannot check free disk space", error); }
      if (available < approval.minFreeBytes) throw new AdmissionError("disk-below-minimum", "Free disk space is below the approved minimum");
    }
    return approval;
  }

  async preflight(signal?: AbortSignal): Promise<ImportApproval | undefined> {
    const approval = await this.localApproval();
    try {
      await this.client.ensureBank(signal);
      await this.client.assertBankConfiguration({ requireExtraction: true, bulk: this.bulkMode, signal });
      await this.client.assertExtractionAvailable(signal);
    } catch (error) { throw new AdmissionError(error instanceof HindsightBankPolicyError ? "extraction-unavailable" : "hindsight-unreachable", errorMessage(error), error); }
    return approval;
  }

  async checkAdmission(signal?: AbortSignal): Promise<Admission> {
    try { return { approval: await inSpan("hindsight.import.preflight", {}, () => this.preflight(signal)) }; }
    catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof AdmissionError)) throw error;
      return { blocked: importBlock(error.reason) };
    }
  }

  async runOnce(limit = this.config.importer.workBatchSize, signal?: AbortSignal, options: { continuous?: boolean; admission?: Admission } = {}): Promise<WorkerSummary> {
    const maxAttempts = this.config.importer.maxAttempts;
    const admission = options.admission ?? (limit > 0 && !signal?.aborted && this.state.hasRunnableWork(maxAttempts) ? await this.checkAdmission(signal) : {});
    const candidates = this.state.listWorkCandidates(limit, maxAttempts, admission.blocked !== undefined);
    const summary: WorkerSummary = { selected: candidates.length, completed: 0, failed: 0, deferred: 0 };
    if (admission.blocked) summary.blocked = admission.blocked;
    await Promise.all(candidates.map((generation) => this.limiter.run(async () => {
      if (signal?.aborted) { summary.deferred += 1; return; }
      const result = await this.process(generation, admission, signal);
      if (typeof result !== "string") {
        summary.blocked ??= result;
        summary.deferred += 1;
      } else summary[result] += 1;
    })));
    const approval = admission.approval;
    const minimum = options.continuous ? approval?.continuousMinFailureSample ?? 1 : 1;
    if (approval?.maxFailureRate !== undefined && summary.selected >= minimum && summary.failed / summary.selected > approval.maxFailureRate) {
      this.logger.error("Import failure rate exceeded approved maximum", { ...summary, maxFailureRate: approval.maxFailureRate });
      throw new ImportFailureRateError(summary, approval.maxFailureRate);
    }
    return summary;
  }

  async drain(maxMs = this.config.hindsight.operationPollTimeoutMs, signal?: AbortSignal): Promise<WorkerSummary> {
    const started = Date.now();
    const total: WorkerSummary = { selected: 0, completed: 0, failed: 0, deferred: 0 };
    while (this.state.pendingWorkCount(this.config.importer.maxAttempts) > 0 && !signal?.aborted) {
      if (Date.now() - started >= maxMs) throw new Error(`Importer still has pending work after ${maxMs} ms`);
      const batch = await this.runOnce(this.config.importer.workBatchSize, signal);
      total.selected += batch.selected; total.completed += batch.completed; total.failed += batch.failed; total.deferred += batch.deferred;
      if (batch.blocked) throw new Error(`Import blocked (${batch.blocked.reason}): ${batch.blocked.action}`);
      if (batch.selected === 0 && !signal?.aborted && this.state.pendingWorkCount(this.config.importer.maxAttempts) > 0) throw new Error("Importer has unresolved generations; inspect status before retrying");
      if (batch.completed === 0 && batch.failed === 0 && this.state.pendingWorkCount(this.config.importer.maxAttempts) > 0) {
        if (!this.state.hasActiveOperations()) throw new Error("Queued work is blocked; inspect session classification and cleanup state");
        await sleep(BLOCKED_QUEUE_RETRY_MS, signal);
      }
    }
    return total;
  }

  private async pollSubmission(generation: GenerationRecord, session: SessionStateRecord, signal: AbortSignal): Promise<"completed"> {
    let reconciled = false;
    try {
      await this.client.waitForOperation(generation.operationId, signal, Math.min(OPERATION_POLL_SLICE_MS, this.config.hindsight.retainWallTimeoutMs), ({ status, progressKey, nextRetryAt }) => {
        this.state.recordOperationPoll(generation.operationId, status, progressKey, nextRetryAt);
      });
    } catch (error) {
      if (!(error instanceof HindsightOperationNotFoundError)) throw error;
      // An unchanged document does not prove that a policy-only rewrite ran.
      const remote = session.acknowledgedHash === generation.canonicalHash ? undefined : await this.client.getDocument(session.documentId, signal);
      if (remote?.id !== session.documentId || remote.content_hash !== generation.canonicalHash) {
        throw new HindsightUnresolvedOperationError("Hindsight no longer has the operation and the document does not prove that the retain succeeded");
      }
      reconciled = true;
    }
    const operation = this.state.getOperation(generation.operationId)!;
    this.state.durableTransaction(() => {
      this.state.upsertOperation({ ...operation, hindsightStatus: "completed", responseSummary: JSON.stringify({ reconciled }) });
      this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "completed", { completedAt: new Date().toISOString() });
    });
    await this.cleanupPayload(generation.operationId);
    this.logger.info("Imported session", { source: generation.source, session: generation.nativeSessionId });
    return "completed";
  }

  private holdSubmission(generation: GenerationRecord, session: SessionStateRecord, reason: string): "deferred" {
    const operation = this.state.getOperation(generation.operationId) ?? { ...generation, documentId: session.documentId, retryCount: 0 };
    this.state.durableTransaction(() => {
      this.state.upsertOperation({ ...operation, hindsightStatus: UNRESOLVED_SUBMISSION });
      this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { error: `${UNRESOLVED_SUBMISSION}: ${reason}. Review the outcome before running retry-unresolved` });
    });
    this.logger.error("Submission requires review", { source: generation.source, session: generation.nativeSessionId, operation: generation.operationId });
    return "deferred";
  }

  private async readPendingPayload(generation: GenerationRecord): Promise<CanonicalSession | undefined> {
    try { return await loadPendingPayload(this.config.spoolDirectory, generation.operationId, generation.canonicalHash); }
    catch (error) {
      if (error instanceof PendingPayloadIntegrityError || error instanceof StaleRedactionPayloadError) throw error;
      throw new HindsightRequestNotSentError({ cause: error });
    }
  }

  private async cleanupPayload(operationId: string): Promise<void> {
    await removePendingPayload(this.config.spoolDirectory, operationId).catch(() => {
      this.logger.warn("Completed operation payload could not be removed", { operation: operationId });
    });
  }

  private async process(generation: GenerationRecord, admission: Admission, shutdownSignal?: AbortSignal): Promise<WorkOutcome> {
    return inSpan("hindsight.import.generation", { source: generation.source, "retry.attempt": generation.attemptCount + 1 }, async (span) => {
      const result = await this.processGeneration(generation, admission, shutdownSignal);
      const outcome = typeof result === "string" ? result : "deferred";
      span?.setAttribute("hindsight.result", outcome);
      telemetryCount("hindsight.import.generations", 1, { source: generation.source, outcome });
      return result;
    }, SpanKind.INTERNAL, (result) => result === "failed" ? "error" : result === "completed" ? "ok" : shutdownSignal?.aborted ? "cancelled" : "incomplete");
  }

  private async processGeneration(generation: GenerationRecord, admission: Admission, shutdownSignal?: AbortSignal): Promise<WorkOutcome> {
    if (generation.state === "failed" && generation.attemptCount >= this.config.importer.maxAttempts) return "deferred";
    let persisted = this.state.getOperation(generation.operationId);
    if (persisted?.hindsightStatus === UNRESOLVED_SUBMISSION) return "deferred";
    const polling = canPollOperation(persisted);
    const sessionState = this.state.getSession(generation.source, generation.nativeSessionId);
    if (!sessionState) return "deferred";
    if (!persisted && generation.state === "submitted") return this.holdSubmission(generation, sessionState, "Submitted generation has no local operation record");
    if (!polling) {
      if (admission.blocked) return "deferred";
      let approval: ImportApproval | undefined;
      try { approval = await this.localApproval(); }
      catch (error) { if (error instanceof AdmissionError) return importBlock(error.reason); throw error; }
      if (approval && !persisted && sessionState.canonicalHash === generation.canonicalHash && sessionState.canonicalBytes !== undefined) {
        const inputTokens = estimateInputTokens(sessionState.canonicalBytes);
        if (!this.state.canReserveBudget(generation.operationId, inputTokens, estimateCostUsd(inputTokens, approval), approval.maxEstimatedInputTokens, approval.maxEstimatedCostUsd)) return importBlock("budget-exceeded");
      }
    }
    if (shutdownSignal?.aborted) return "deferred";
    const unclaimed = generation;
    if (!this.state.claimGeneration(generation)) return "deferred";
    const claimedAt = Date.now();
    generation = this.state.getGeneration(generation.source, generation.nativeSessionId, generation.canonicalHash)!;
    let session: CanonicalSession | undefined;
    let previousPayloadId: string | undefined;
    if (generation.repair && !persisted && sessionState.acknowledgedPolicy === generation.retainPolicyVersion) generation = { ...generation, repair: false };
    const deadlineSignal = AbortSignal.timeout(this.config.hindsight.retainWallTimeoutMs);
    const operationSignal = shutdownSignal ? AbortSignal.any([shutdownSignal, deadlineSignal]) : deadlineSignal;
    try {
      operationSignal.throwIfAborted();
      if (persisted && TERMINAL_OPERATION_FAILURES.includes(persisted.hindsightStatus ?? "")) {
        session = await this.readPendingPayload(generation);
        previousPayloadId = session ? generation.operationId : undefined;
        generation = { ...generation, operationId: nextOperationId(this.state, this.config.hindsight.bankId, sessionState.documentId, generation.canonicalHash, generation.operationId), submittedAt: undefined, completedAt: undefined };
        persisted = undefined;
      }
      if (polling) return await this.pollSubmission(generation, sessionState, operationSignal);
      if (persisted) session = await this.readPendingPayload(generation);
      const origin = sessionState.sourceOrigin ?? this.config.localOrigin;
      const adapter = createAdapters(this.config, origin).find((item) => item.source === generation.source);
      if (!adapter) throw new Error(`No adapter for ${generation.source} on ${origin}`);
      const reference = referenceFromState(sessionState);
      const immutable = session?.classification;
      session ??= await inSpan("hindsight.source.normalize", { source: generation.source }, () => adapter.load(reference, { spoolDirectory: this.config.spoolDirectory, maxCanonicalBytes: this.config.maxCanonicalBytes, signal: operationSignal }));
      operationSignal.throwIfAborted();
      let structuralClassification;
      try { structuralClassification = await adapter.classify(reference); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || immutable?.kind !== "primary") throw error;
        structuralClassification = immutable;
      }
      if (structuralClassification.reason === "opencode-session-disappeared-during-classification" && immutable?.kind === "primary") structuralClassification = immutable;
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
      if (session.canonicalHash !== generation.canonicalHash) {
        if (persisted) throw new PendingPayloadIntegrityError("Pending payload is unavailable and the source no longer matches the generation");
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "superseded", { error: "Source changed before submission" });
        return "deferred";
      }
      if (session.emptyAfterNormalization) throw new Error("Refusing to retain an empty generation");
      if (session.metadata.redaction_policy_version !== REDACTION_POLICY_VERSION) throw new StaleRedactionPayloadError();
      if (generation.repair && !this.repairMode) throw new Error("Historical evidence-policy repair requires a reviewed plan-repair/repair command");
      const approval = await this.localApproval();
      if (approval) {
        const inputTokens = estimateInputTokens(session.canonicalBytes);
        if (!this.state.reserveBudget(generation.operationId, inputTokens, estimateCostUsd(inputTokens, approval), approval.maxEstimatedInputTokens, approval.maxEstimatedCostUsd)) {
          this.state.upsertGeneration(unclaimed);
          return importBlock("budget-exceeded");
        }
      }
      if (unclaimed.state === "queued" && unclaimed.attemptCount === 0) telemetryQueueWait((claimedAt - Date.parse(unclaimed.queuedAt)) / MS_PER_SECOND, generation.source);
      if (!persisted) {
        await inSpan("hindsight.payload.persist", { source: generation.source, "hindsight.canonical.bytes": session.canonicalBytes }, () => savePendingPayload(this.config.spoolDirectory, generation.operationId, session!));
        this.state.durableTransaction(() => {
          this.state.upsertGeneration(generation);
          this.state.upsertOperation({ operationId: generation.operationId, documentId: session!.documentId, canonicalHash: generation.canonicalHash, hindsightStatus: "prepared", retryCount: 0 });
        });
        persisted = this.state.getOperation(generation.operationId)!;
        if (previousPayloadId) {
          session = await this.readPendingPayload(generation);
          if (!session) throw new PendingPayloadIntegrityError("Retry payload is unavailable");
          await this.cleanupPayload(previousPayloadId);
        }
      }
      if (persisted.hindsightStatus === "prepared") {
        if (generation.repair) {
          const remote = await this.client.getDocument(session.documentId, operationSignal);
          if (remote && ![sessionState.acknowledgedHash, generation.canonicalHash].includes(remote.content_hash)) throw new Error("Remote document changed outside the reviewed repair generation");
          if (remote) {
            try { await this.client.deleteDocument(session.documentId, operationSignal); }
            catch (error) { if (!(error instanceof HindsightHttpError) || error.status !== HTTP_STATUS.NOT_FOUND) throw error; }
          }
        }
        this.state.durableTransaction(() => { this.state.upsertOperation({ ...persisted!, hindsightStatus: "ready" }); });
      }
      operationSignal.throwIfAborted();
      await inSpan("hindsight.retain.submit", { source: generation.source, "hindsight.canonical.bytes": session.canonicalBytes, "hindsight.canonical.turns": session.canonicalTurns }, () => this.client.retainWithOperationId(session!, generation.operationId, operationSignal, () => {
        const submittedAt = new Date().toISOString();
        this.state.durableTransaction(() => {
          this.state.upsertOperation({ ...persisted!, hindsightStatus: "submitting", submittedAt });
          this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { submittedAt });
        });
      }));
      this.state.upsertOperation({ ...persisted, hindsightStatus: "pending" });
      return await this.pollSubmission(generation, sessionState, operationSignal);
    } catch (error) {
      const localError = error instanceof HindsightRequestNotSentError ? error.cause : error;
      if (localError instanceof PendingPayloadIntegrityError) {
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "failed", { attemptCount: this.config.importer.maxAttempts, error: localError.message });
        this.logger.error("Session import failed", { source: generation.source, session: generation.nativeSessionId, error: localError.message });
        return "failed";
      }
      if (error instanceof HindsightRequestNotSentError) {
        this.state.restoreUnsentOperation(generation);
        return "deferred";
      }
      if (error instanceof HindsightUnresolvedOperationError) return this.holdSubmission(generation, sessionState, error.message);
      if (shutdownSignal?.aborted) {
        this.logger.info("Session import interrupted by shutdown", { source: generation.source, session: generation.nativeSessionId });
        return "deferred";
      }
      if (error instanceof StaleRedactionPayloadError) {
        this.state.durableTransaction(() => {
          this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { error: error.message });
        });
        return "deferred";
      }
      if (error instanceof AdmissionError) {
        this.state.upsertGeneration(unclaimed);
        return importBlock(error.reason);
      }
      const operation = this.state.getOperation(generation.operationId);
      const message = redactText(errorMessage(error)).text.slice(0, ERROR_MESSAGE_MAX_CHARS);
      const rejected = error instanceof HindsightHttpError && error.method === "POST" && error.status >= HTTP_STATUS.BAD_REQUEST && error.status < HTTP_STATUS.INTERNAL_SERVER_ERROR && error.status !== HTTP_STATUS.CONFLICT && !isRetryableStatus(error.status);
      const terminal = error instanceof HindsightOperationError || rejected;
      if (operation && !terminal) {
        this.state.setGenerationState(generation.source, generation.nativeSessionId, generation.canonicalHash, "submitted", { error: error instanceof HindsightPollTimeoutError ? undefined : message });
        return "deferred";
      }
      this.state.durableTransaction(() => {
        if (operation) this.state.upsertOperation({ ...operation, hindsightStatus: error instanceof HindsightOperationError ? error.status : "rejected" });
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
