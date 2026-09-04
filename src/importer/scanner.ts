import fs from "node:fs/promises";
import type { AppConfig, Source, SourceFingerprint, SessionReference, InventorySessionResult } from "../common/types.js";
import { ADAPTER_VERSION, CANONICAL_SCHEMA, CLASSIFICATION_POLICY_VERSION, REDACTION_POLICY_VERSION } from "../common/types.js";
import { documentIdFor } from "../common/hashing.js";
import { createAdapters } from "../adapters/index.js";
import type { SessionAdapter } from "../adapters/adapter.js";
import { queueGeneration } from "./queue.js";
import { StateDatabase } from "./state-db.js";
import { errorMessage } from "../common/logging.js";
import { configuredExclusion, normalizeSessionLabel } from "./exclusions.js";

export interface ScanOptions {
  inventoryOnly?: boolean;
  force?: boolean;
  source?: Source;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface ScanSummary {
  discovered: number;
  queued: number;
  unchanged: number;
  active: number;
  empty: number;
  errors: number;
  sourceMissing: number;
  excluded: number;
  configured: number;
  ambiguous: number;
  results: InventorySessionResult[];
}

export function processingSignature(config: AppConfig): string {
  const exclusions = [...config.sessionExclusions.exactLabels].map(normalizeSessionLabel).sort();
  return `${CANONICAL_SCHEMA}|${ADAPTER_VERSION}|${REDACTION_POLICY_VERSION}|classification:${CLASSIFICATION_POLICY_VERSION}|exclusions:${JSON.stringify(exclusions)}`;
}

interface Discovered { adapter: SessionAdapter; reference: SessionReference; }
function fingerprintSignature(value: unknown): string { return JSON.stringify(value); }
async function exists(value: string): Promise<boolean> { try { await fs.access(value); return true; } catch { return false; } }
function sourceRoot(adapter: SessionAdapter, config: AppConfig): string { return adapter.source === "opencode" ? config.opencodeDatabase : config.sourceRoots[adapter.source]; }
function withProcessingSignature(fingerprint: SourceFingerprint, signature: string): SourceFingerprint { return { ...fingerprint, processing_signature: signature }; }
function timestampOf(reference: SessionReference): number { const value = reference.sessionStartedAt ? Date.parse(reference.sessionStartedAt) : Number.NaN; return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value; }

export function effectiveReference(state: StateDatabase, reference: SessionReference): SessionReference {
  const alias = state.findSessionByAlias(reference.source, reference.locator);
  if (!alias || alias === reference.nativeSessionId) return reference;
  return { ...reference, nativeSessionId: alias, metadata: { ...reference.metadata, native_session_id: alias }, identityIsFallback: false };
}

export async function scan(config: AppConfig, state: StateDatabase, options: ScanOptions = {}): Promise<ScanSummary> {
  const adapters = createAdapters(config).filter((adapter) => !options.source || adapter.source === options.source);
  const signature = processingSignature(config);
  const summary: ScanSummary = { discovered: 0, queued: 0, unchanged: 0, active: 0, empty: 0, errors: 0, sourceMissing: 0, excluded: 0, configured: 0, ambiguous: 0, results: [] };
  const discovered: Discovered[] = [];
  const healthy = new Map<Source, boolean>();
  const seen = new Map<Source, Set<string>>();
  for (const adapter of adapters) {
    state.upsertSource(adapter.source, sourceRoot(adapter, config));
    healthy.set(adapter.source, true);
    seen.set(adapter.source, new Set());
    state.markScanStarted(adapter.source, new Date().toISOString());
    try {
      for await (const reference of adapter.discover()) {
        options.signal?.throwIfAborted();
        discovered.push({ adapter, reference });
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      healthy.set(adapter.source, false);
      state.markScanError(adapter.source, errorMessage(error));
      summary.errors += 1;
    }
  }
  discovered.sort((a, b) => timestampOf(a.reference) - timestampOf(b.reference) || a.adapter.source.localeCompare(b.adapter.source) || a.reference.nativeSessionId.localeCompare(b.reference.nativeSessionId));
  const offset = options.offset ?? 0;
  const selected = options.limit === undefined ? discovered.slice(offset) : discovered.slice(offset, offset + options.limit);
  for (const item of selected) {
    options.signal?.throwIfAborted();
    const { adapter, reference: discoveredReference } = item;
    const structuralClassification = discoveredReference.classification ?? await adapter.classify(discoveredReference);
    const label = discoveredReference.sessionLabel ?? discoveredReference.metadata.title ?? structuralClassification.label;
    const documentId = documentIdFor(adapter.source, discoveredReference.nativeSessionId);
    const configured = configuredExclusion(label, config.sessionExclusions);
    const tombstone = state.getExclusionTombstone(adapter.source, discoveredReference.nativeSessionId, documentId);
    const classification = configured ?? (tombstone ? { kind: "configured-exclusion" as const, reason: `persisted-configured-exclusion:${tombstone.label}`, policyVersion: structuralClassification.policyVersion } : structuralClassification);
    const reference = { ...effectiveReference(state, discoveredReference), classification, ...(label ? { sessionLabel: label } : {}) };
    if (configured && label) {
      state.recordExclusionTombstone({ source: adapter.source, nativeSessionId: reference.nativeSessionId, documentId, locator: discoveredReference.locator, label, normalizedLabel: label.normalize("NFKC").trim().toLowerCase(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    state.recordArtifact({
      source: adapter.source,
      locator: discoveredReference.locator,
      nativeSessionId: reference.nativeSessionId,
      documentId: documentIdFor(adapter.source, reference.nativeSessionId),
      classification,
      observedAt: new Date().toISOString(),
      sessionStartedAt: reference.sessionStartedAt,
      sessionUpdatedAt: reference.sessionUpdatedAt,
    });
    summary.discovered += 1;
    if (classification.kind !== "primary") {
      if (classification.kind === "subagent") summary.excluded += 1;
      else if (classification.kind === "configured-exclusion") summary.configured += 1;
      else summary.ambiguous += 1;
      const existing = state.getSession(adapter.source, reference.nativeSessionId);
      const sameArtifact = existing?.sourceLocator === reference.locator;
      const safeToMutateSession = existing && (adapter.source !== "claude" || sameArtifact);
      state.clearScanCandidate(adapter.source, reference.nativeSessionId);
      if (safeToMutateSession) {
        const latest = state.getLatestGeneration(adapter.source, reference.nativeSessionId);
        const preserveAmbiguous = classification.kind === "ambiguous" && latest?.state === "completed";
        const excludedStatus = classification.kind === "subagent" ? "excluded_subagent" : classification.kind === "configured-exclusion" ? "excluded_configured" : preserveAmbiguous ? "ambiguous_preserved" : "excluded_ambiguous";
        state.setSessionClassification(adapter.source, reference.nativeSessionId, classification, excludedStatus);
        if (!preserveAmbiguous) state.markSessionGenerationsCleanupPending(adapter.source, reference.nativeSessionId, `${classification.kind}: classification changed or was discovered after import`);
      }
      summary.results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: classification.kind === "subagent" ? "excluded_subagent" : classification.kind === "configured-exclusion" ? "excluded_configured" : "ambiguous" });
      continue;
    }
    seen.get(adapter.source)?.add(reference.nativeSessionId);
    let fingerprint: SourceFingerprint;
    try { fingerprint = withProcessingSignature(await adapter.fingerprint(reference), signature); }
    catch (error) {
      healthy.set(adapter.source, false); summary.errors += 1;
      summary.results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: "error", error: errorMessage(error) });
      continue;
    }
    const previous = state.getSession(adapter.source, reference.nativeSessionId);
    const unchanged = previous && !options.inventoryOnly && !options.force && previous.canonicalHash && fingerprintSignature(previous.sourceFingerprint) === fingerprintSignature(fingerprint);
    if (unchanged) {
      state.clearScanCandidate(adapter.source, reference.nativeSessionId);
      summary.unchanged += 1;
      const latest = state.getLatestGeneration(adapter.source, reference.nativeSessionId);
      const restoredStatus = previous.status === "source_missing" ? latest?.state === "completed" ? "imported" : "discovered" : previous.status;
      state.markSessionSeen(adapter.source, reference.nativeSessionId, fingerprint, fingerprint.size, fingerprint.mtimeMs, restoredStatus);
      summary.results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: "eligible", canonicalBytes: previous.canonicalBytes, canonicalTurns: previous.canonicalTurns, startedAt: previous.sessionStartedAt, updatedAt: previous.sessionUpdatedAt });
      continue;
    }
    const settled = options.force || config.sessionSettleSeconds === 0 || state.observeScanCandidate(
      adapter.source,
      reference.nativeSessionId,
      fingerprintSignature(fingerprint),
      new Date().toISOString(),
      config.sessionSettleSeconds * 1_000,
    );
    if (!settled) {
      summary.active += 1;
      summary.results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status: "active", startedAt: reference.sessionStartedAt, updatedAt: reference.sessionUpdatedAt });
      continue;
    }
    state.clearScanCandidate(adapter.source, reference.nativeSessionId);

    let session;
    let loaded = false;
    try {
      for (let attempt = 0; attempt < 2 && !loaded; attempt += 1) {
        session = await adapter.load(reference, { spoolDirectory: config.spoolDirectory, maxCanonicalBytes: config.maxCanonicalBytes });
        if (options.signal?.aborted) {
          await session.cleanup();
          options.signal.throwIfAborted();
        }
        const after = withProcessingSignature(await adapter.fingerprint(reference), signature);
        if (fingerprintSignature(fingerprint) !== fingerprintSignature(after)) {
          await session.cleanup();
          if (attempt === 1) throw new Error("Source changed while it was being normalized; retry on the next scan");
          fingerprint = after;
          continue;
        }
        fingerprint = after;
        loaded = true;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      healthy.set(adapter.source, false); summary.errors += 1;
      const message = errorMessage(error);
      const status = /configured limit|exceeds .* bytes/i.test(message) ? "too_large" as const : /JSON|malformed|Unexpected token/i.test(message) ? "malformed" as const : "error" as const;
      summary.results.push({ source: adapter.source, nativeSessionId: reference.nativeSessionId, locator: reference.locator, status, error: message });
      continue;
    }
    if (!session) continue;
    try {
      const tooLarge = session.canonicalBytes > config.maxCanonicalBytes;
      summary.results.push({ source: adapter.source, nativeSessionId: session.nativeSessionId, locator: reference.locator, status: tooLarge ? "too_large" : session.emptyAfterNormalization ? "empty_after_normalization" : "eligible", canonicalBytes: session.canonicalBytes, canonicalTurns: session.canonicalTurns, redactionCount: session.redactionCount, startedAt: session.sessionStartedAt, updatedAt: session.sessionUpdatedAt });
      if (tooLarge) { healthy.set(adapter.source, false); summary.errors += 1; continue; }
      if (session.emptyAfterNormalization) summary.empty += 1;
      if (!options.inventoryOnly) {
        state.upsertSession({ source: session.source, nativeSessionId: session.nativeSessionId, documentId: session.documentId, sourceLocator: session.sourceLocator, sourceSize: fingerprint.size, sourceMtime: fingerprint.mtimeMs, sourceFingerprint: fingerprint, canonicalHash: session.canonicalHash, canonicalBytes: session.canonicalBytes, canonicalTurns: session.canonicalTurns, canonicalSchema: CANONICAL_SCHEMA, sessionStartedAt: session.sessionStartedAt, sessionUpdatedAt: session.sessionUpdatedAt, status: session.emptyAfterNormalization ? "empty_after_normalization" : "discovered", lastSeenAt: new Date().toISOString(), classification: session.classification ?? classification });
        state.addAlias(session.source, reference.locator, session.nativeSessionId);
        const generation = queueGeneration(state, session, config.hindsight.bankId);
        if (generation) summary.queued += 1;
        else if (!session.emptyAfterNormalization && state.getLatestGeneration(session.source, session.nativeSessionId)?.state === "completed") state.setSessionStatus(session.source, session.nativeSessionId, "imported");
      }
    } finally { await session.cleanup().catch(() => undefined); }
  }

  if (!options.inventoryOnly && options.limit === undefined && options.offset === undefined) {
    for (const adapter of adapters) {
      if (!healthy.get(adapter.source) || !(await exists(sourceRoot(adapter, config)))) continue;
      for (const old of state.listSessions(adapter.source)) {
        if (!seen.get(adapter.source)?.has(old.nativeSessionId) && !["source_missing", "excluded_subagent", "excluded_ambiguous", "excluded_configured", "ambiguous_preserved", "cleanup_pending"].includes(old.status)) { state.markSourceMissing(old.source, old.nativeSessionId, new Date().toISOString()); summary.sourceMissing += 1; }
      }
    }
  }
  for (const adapter of adapters) if (healthy.get(adapter.source)) state.markScanCompleted(adapter.source, new Date().toISOString());
  return summary;
}
