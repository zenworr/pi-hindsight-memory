import fs from "node:fs/promises";
import type { HindsightBankConfigResponse, HindsightBankStats, HindsightConfig, HindsightOperation, HindsightVersionResponse, RecallResponse } from "../common/types.js";
import type { CanonicalSession } from "../common/types.js";
import { errorMessage } from "../common/logging.js";
import { redactText } from "../canonical/redact.js";
import { RETAIN_POLICY_VERSION } from "../common/types.js";
import { expectedRetainMission } from "../common/retention-policy.js";
import { sleep } from "../common/async.js";
import { MS_PER_SECOND, CHARS_PER_ESTIMATED_TOKEN } from "../common/limits.js";
import { HTTP_STATUS, isRetryableStatus } from "./http.js";
import { inSpan, telemetryCount, traceHeaders } from "../common/telemetry.js";
import { SpanKind } from "@opentelemetry/api";

const RETRY_BACKOFF_FACTOR = 2;
const RATE_LIMIT_FALLBACK_DELAY_MS = 1_000;
const MAX_RECALL_QUERY_TOKENS = 500;

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class HindsightHttpError extends Error {
  constructor(public readonly status: number, public readonly method: string, public readonly url: string, public readonly body: string, public readonly retryAfterMs?: number) {
    super(`${method} ${url} failed with HTTP ${status}`);
    this.name = "HindsightHttpError";
  }
}

export class HindsightOperationError extends Error {
  constructor(readonly status: string, readonly operationId: string) {
    super(`Hindsight operation ${operationId} ended ${status}`);
  }
}

export class HindsightPollTimeoutError extends Error {}

export interface HindsightDocument {
  id: string;
  content_hash?: string;
  original_text?: string;
  retain_params?: { metadata?: Record<string, string> };
}

interface RetainItem {
  content: string;
  context: string;
  document_id: string;
  update_mode: "replace";
  timestamp: string;
  strategy: string;
  tags: string[];
  observation_scopes: "shared";
  metadata: Record<string, string>;
}

export interface RetainResponse {
  operation_id?: string;
  operation_ids?: string[];
  success?: boolean;
  bank_id?: string;
  items_count?: number;
  async?: boolean;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * MS_PER_SECOND));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function estimateTokens(text: string): number { return Math.ceil([...text].length / CHARS_PER_ESTIMATED_TOKEN); }

export class HindsightClient {
  private bankEnsured = false;
  private bankConfigurationVerified = false;
  private extractionAvailabilityVerified = false;
  constructor(
    private readonly config: HindsightConfig,
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly fixedToken?: string,
  ) {}

  private bankUrl(suffix = ""): string {
    return `${this.config.apiUrl.replace(/\/$/, "")}/v1/default/banks/${encodeURIComponent(this.config.bankId)}${suffix}`;
  }

  private async token(): Promise<string> {
    if (this.fixedToken !== undefined) return this.fixedToken;
    const token = (await fs.readFile(this.config.apiTokenFile, "utf8")).trim();
    if (!token) throw new Error(`Hindsight API token file is empty: ${this.config.apiTokenFile}`);
    return token;
  }

  private async tokenChanged(previous: string): Promise<boolean> {
    if (this.fixedToken !== undefined) return false;
    try {
      const current = (await fs.readFile(this.config.apiTokenFile, "utf8")).trim();
      if (!current || current === previous) return false;
      return true;
    } catch { return false; }
  }

  async requestJson<T>(method: string, url: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.config.requestTimeoutMs): Promise<T> {
    return inSpan("hindsight.http.request", { "http.request.method": method, "http.route": this.route(url) }, () => this.sendJson<T>(method, url, body, signal, timeoutMs));
  }

  private route(url: string): string {
    const pathname = new URL(url).pathname;
    if (["/health", "/version"].includes(pathname)) return pathname;
    const suffix = pathname.startsWith(new URL(this.bankUrl()).pathname) ? pathname.slice(new URL(this.bankUrl()).pathname.length) : "/other";
    if (["", "/profile", "/config", "/stats", "/import", "/memories", "/memories/recall", "/memories/dry-run-extract", "/consolidate", "/operations", "/documents"].includes(suffix)) return `/banks/{bank}${suffix}`;
    if (/^\/(operations|documents)\/[^/]+$/.test(suffix)) return `/banks/{bank}/${suffix.split("/")[1]}/{id}`;
    return "/other";
  }

  private async sendJson<T>(method: string, url: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let token = await this.token();
    let authRetry = false;
    for (let attempt = 0; attempt < this.config.httpMaxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${method} ${url}: request exceeded ${timeoutMs} ms`);
      const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
      const request: RequestInit = { method, headers };
      if (payload !== undefined) { headers["Content-Type"] = "application/json"; request.body = payload; }
      const timeout = AbortSignal.timeout(Math.max(1, remaining));
      request.signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await inSpan("hindsight.http.attempt", { "http.request.method": method, "http.route": this.route(url), "retry.attempt": attempt + 1 }, async (span) => {
          Object.assign(headers, traceHeaders());
          const result = await this.fetcher(url, request);
          span?.setAttribute("http.response.status_code", result.status);
          telemetryCount("hindsight.http.responses", 1, { method, route: this.route(url), status: result.status });
          return result;
        }, SpanKind.CLIENT, (result) => result.ok ? "ok" : "error");
      } catch (error) {
        if (attempt + 1 < this.config.httpMaxAttempts && !signal?.aborted && Date.now() < deadline) {
          telemetryCount("hindsight.http.retries", 1, { reason: "transport" });
          await sleep(Math.min(this.config.httpRetryDelayMs * RETRY_BACKOFF_FACTOR ** attempt, this.config.httpMaxRetryDelayMs, Math.max(0, deadline - Date.now())), signal);
          continue;
        }
        // eslint-disable-next-line preserve-caught-error -- Transport causes can include credentials.
        throw new Error(`${method} ${url}: ${errorMessage(error)}`);
      }
      if (response.status === HTTP_STATUS.UNAUTHORIZED && !authRetry && await this.tokenChanged(token) && Date.now() < deadline) {
        await response.body?.cancel();
        token = await this.token();
        telemetryCount("hindsight.http.retries", 1, { reason: "authentication" });
        authRetry = true;
        continue;
      }
      if (response.ok) {
        if (response.status === HTTP_STATUS.NO_CONTENT) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try { return JSON.parse(text) as T; }
        catch { throw new Error(`${method} ${url}: server returned invalid JSON`); }
      }
      const responseBody = await response.text();
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (isRetryableStatus(response.status) && attempt + 1 < this.config.httpMaxAttempts && !signal?.aborted && Date.now() < deadline) {
        telemetryCount("hindsight.http.retries", 1, { reason: "http", status: response.status });
        const requestedWait = Math.min(this.config.httpMaxRetryDelayMs, response.status === HTTP_STATUS.TOO_MANY_REQUESTS ? retryAfterMs ?? RATE_LIMIT_FALLBACK_DELAY_MS : this.config.httpRetryDelayMs * RETRY_BACKOFF_FACTOR ** attempt);
        const wait = Math.min(requestedWait, Math.max(0, deadline - Date.now()));
        await sleep(wait, signal);
        continue;
      }
      throw new HindsightHttpError(response.status, method, url, responseBody, retryAfterMs);
    }
    throw new Error(`${method} ${url}: request retry limit exceeded`);
  }

  async ensureBank(signal?: AbortSignal): Promise<void> {
    if (this.bankEnsured) return;
    const url = this.bankUrl("/profile");
    try { await this.requestJson("GET", url, undefined, signal); this.bankEnsured = true; return; }
    catch (error) {
      if (!(error instanceof HindsightHttpError) || error.status !== HTTP_STATUS.NOT_FOUND) throw error;
    }
    await this.requestJson("PUT", this.bankUrl(), { name: this.config.bankId }, signal);
    this.bankEnsured = true;
  }

  async assertExtractionAvailable(signal?: AbortSignal): Promise<void> {
    if (this.extractionAvailabilityVerified) return;
    const version = await this.requestJson<HindsightVersionResponse>("GET", `${this.config.apiUrl.replace(/\/$/, "")}/version`, undefined, signal);
    if (version.features?.observations === false) throw new Error("Hindsight is running without an extraction/consolidation LLM; configure an approved provider before importing durable memory");
    this.extractionAvailabilityVerified = true;
  }

  async assertBankConfiguration(options: { requireExtraction?: boolean; bulk?: boolean; signal?: AbortSignal } = {}): Promise<HindsightBankConfigResponse> {
    if (this.bankConfigurationVerified && options.requireExtraction !== true) return {};
    const response = await this.getBankConfig(options.signal);
    const config = response.config ?? {};
    const strategies = config.retain_strategies;
    const conversation = strategies && typeof strategies === "object" ? (strategies as Record<string, unknown>).conversation : undefined;
    if (!conversation || typeof conversation !== "object") throw new Error(`Hindsight bank ${this.config.bankId} has no named conversation retain strategy`);
    if (config.store_document_text !== true) throw new Error("Hindsight bank must have store_document_text=true; mutable source documents require stored text");
    if (options.requireExtraction) {
      const extractionMode = (conversation as Record<string, unknown>).retain_extraction_mode ?? config.retain_extraction_mode;
      if (extractionMode === "chunks" || extractionMode !== "concise" && extractionMode !== "verbose") throw new Error(`Hindsight conversation strategy has invalid extraction mode: ${String(extractionMode)}`);
      if (config.enable_observations !== true) throw new Error("Hindsight observations are disabled for the production bank");
      if (typeof config.observations_mission !== "string" || !config.observations_mission.trim()) throw new Error("Hindsight observations mission is missing");
      const effectiveMission = (conversation as Record<string, unknown>).retain_mission ?? config.retain_mission;
      if (effectiveMission !== await expectedRetainMission()) throw new Error("Hindsight effective conversation mission does not match the required evidence policy");
      if (config.retain_default_strategy !== "conversation") throw new Error("Hindsight default retain strategy is not conversation");
      if (options.bulk && config.enable_auto_consolidation !== false) throw new Error("Hindsight auto-consolidation must be disabled during bulk import");
    }
    this.bankConfigurationVerified = true;
    return response;
  }

  async getBankConfig(signal?: AbortSignal): Promise<HindsightBankConfigResponse> {
    return this.requestJson<HindsightBankConfigResponse>("GET", this.bankUrl("/config"), undefined, signal);
  }

  async getBankStats(signal?: AbortSignal): Promise<HindsightBankStats> {
    return this.requestJson<HindsightBankStats>("GET", this.bankUrl("/stats"), undefined, signal);
  }

  async updateBankConfig(updates: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.requestJson("PATCH", this.bankUrl("/config"), { updates }, signal);
  }

  async importBankTemplate(manifest: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.requestJson("POST", this.bankUrl("/import"), manifest, signal);
  }

  async retainWithOperationId(session: CanonicalSession, operationId: string, signal?: AbortSignal): Promise<RetainResponse> {
    const content = await session.readContent();
    const metadata = Object.fromEntries(Object.entries({
      source: session.metadata.source,
      native_session_id: session.metadata.native_session_id,
      source_path: session.metadata.source_path,
      cwd: session.metadata.cwd,
      title: session.metadata.title,
      parent_session_id: session.metadata.parent_session_id,
      project_id: session.metadata.project_id,
      agent: session.metadata.agent,
      model: session.metadata.model,
      canonical_schema: session.metadata.canonical_schema,
      adapter_version: session.metadata.adapter_version,
      redaction_policy_version: session.metadata.redaction_policy_version,
      canonical_hash: session.canonicalHash,
      retain_policy_version: RETAIN_POLICY_VERSION,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [key, redactText(value).text]));
    const item: RetainItem = {
      content,
      context: `Global coding-agent session from ${session.source}`,
      document_id: session.documentId,
      update_mode: "replace",
      timestamp: session.sessionStartedAt,
      strategy: "conversation",
      tags: [`source:${session.source}`, `schema:${session.metadata.canonical_schema}`],
      observation_scopes: "shared",
      metadata,
    };
    return this.requestJson<RetainResponse>("POST", this.bankUrl("/memories"), { items: [item], async: true, operation_id: operationId }, signal);
  }

  async getOperation(operationId: string, signal?: AbortSignal): Promise<HindsightOperation> {
    return this.requestJson<HindsightOperation>("GET", this.bankUrl(`/operations/${encodeURIComponent(operationId)}`), undefined, signal);
  }

  async listOperations(status?: string, signal?: AbortSignal): Promise<HindsightOperation[]> {
    const operations: HindsightOperation[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (status) query.set("status", status);
      const response = await this.requestJson<{ operations?: HindsightOperation[]; total?: number }>("GET", this.bankUrl(`/operations?${query}`), undefined, signal);
      const page = response.operations ?? [];
      operations.push(...page);
      if (page.length < limit || response.total !== undefined && operations.length >= response.total) break;
    }
    return operations;
  }

  async waitForOperation(operationId: string, signal?: AbortSignal, timeoutMs = this.config.operationPollTimeoutMs): Promise<HindsightOperation> {
    const started = Date.now();
    for (;;) {
      const operation = await this.getOperation(operationId, signal);
      const status = String(operation.status ?? "").toLowerCase();
      if (["not_found", "not found", "404"].includes(status)) {
        throw new HindsightHttpError(HTTP_STATUS.NOT_FOUND, "GET", this.bankUrl(`/operations/${encodeURIComponent(operationId)}`), "");
      }
      if (["completed", "failed", "cancelled", "error"].includes(status)) {
        if (status !== "completed") throw new HindsightOperationError(status, operationId);
        return operation;
      }
      if (signal?.aborted) throw new Error(`Hindsight operation ${operationId} was aborted`);
      if (Date.now() - started >= timeoutMs) throw new HindsightPollTimeoutError(`Hindsight operation ${operationId} is still pending after ${timeoutMs} ms`);
      await sleep(Math.min(this.config.operationPollMs, Math.max(1, timeoutMs - (Date.now() - started))), signal);
    }
  }

  async dryRunExtract(content: string, overrides: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!content.trim()) throw new Error("dry-run extraction content must not be empty");
    return this.requestJson<Record<string, unknown>>("POST", this.bankUrl("/memories/dry-run-extract"), { content, context: "Global coding-agent session", ...overrides }, signal, this.config.dryRunTimeoutMs);
  }

  async recall(query: string, signal?: AbortSignal): Promise<RecallResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("memory_search query must not be empty");
    if (estimateTokens(trimmed) > MAX_RECALL_QUERY_TOKENS) throw new Error("memory_search query is longer than Hindsight's 500-token limit");
    const body = {
      query: trimmed,
      types: ["world", "experience", "observation"],
      prefer_observations: true,
      budget: "mid",
      max_tokens: this.config.recallMaxTokens,
      query_timestamp: new Date().toISOString(),
      include: {
        chunks: { max_tokens: this.config.recallChunksMaxTokens },
        source_facts: { max_tokens: this.config.recallSourceFactsMaxTokens },
        entities: null,
      },
    };
    return this.requestJson<RecallResponse>("POST", this.bankUrl("/memories/recall"), body, signal);
  }

  async consolidate(observationScopes?: string[][], signal?: AbortSignal): Promise<{ operation_id?: string }> {
    const body = observationScopes ? { observation_scopes: observationScopes } : undefined;
    return this.requestJson<{ operation_id?: string }>("POST", this.bankUrl("/consolidate"), body, signal);
  }

  async listDocumentIds(signal?: AbortSignal): Promise<Set<string>> {
    return new Set((await this.listDocuments(signal)).map((document) => document.id));
  }

  async listDocuments(signal?: AbortSignal): Promise<HindsightDocument[]> {
    const documents: HindsightDocument[] = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const response = await this.requestJson<{ items?: HindsightDocument[]; total?: number }>("GET", this.bankUrl(`/documents?limit=${limit}&offset=${offset}`), undefined, signal);
      const items = response.items ?? [];
      documents.push(...items);
      if (items.length < limit || response.total !== undefined && documents.length >= response.total) break;
    }
    return documents;
  }

  async getDocument(documentId: string, signal?: AbortSignal): Promise<HindsightDocument | undefined> {
    try { return await this.requestJson<HindsightDocument>("GET", this.bankUrl(`/documents/${encodeURIComponent(documentId)}`), undefined, signal); }
    catch (error) { if (error instanceof HindsightHttpError && error.status === HTTP_STATUS.NOT_FOUND) return undefined; throw error; }
  }

  async cancelOperation(operationId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.requestJson("DELETE", this.bankUrl(`/operations/${encodeURIComponent(operationId)}`), undefined, signal);
      return true;
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === HTTP_STATUS.CONFLICT) return false;
      throw error;
    }
  }

  async deleteDocument(documentId: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson("DELETE", this.bankUrl(`/documents/${encodeURIComponent(documentId)}`), undefined, signal);
  }

  async deleteBank(signal?: AbortSignal): Promise<void> {
    await this.requestJson("DELETE", this.bankUrl(), undefined, signal);
    this.bankEnsured = false;
    this.bankConfigurationVerified = false;
    this.extractionAvailabilityVerified = false;
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("GET", `${this.config.apiUrl.replace(/\/$/, "")}/health`, undefined, signal);
  }
}
