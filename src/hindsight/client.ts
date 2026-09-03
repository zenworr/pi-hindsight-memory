import fs from "node:fs/promises";
import type { HindsightBankConfigResponse, HindsightBankStats, HindsightConfig, HindsightOperation, HindsightVersionResponse, RecallResponse } from "../common/types.js";
import type { CanonicalSession } from "../common/types.js";
import { errorMessage } from "../common/logging.js";

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class HindsightHttpError extends Error {
  constructor(public readonly status: number, public readonly method: string, public readonly url: string, public readonly body: string, public readonly retryAfterMs?: number) {
    super(`${method} ${url} failed with HTTP ${status}`);
    this.name = "HindsightHttpError";
  }
}

export class HindsightRateLimitError extends HindsightHttpError {}

export interface RetainItem {
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
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function estimateTokens(text: string): number { return Math.ceil([...text].length / 4); }

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!signal) return { signal: timeout, cleanup: () => undefined };
  const combined = AbortSignal.any([signal, timeout]);
  return { signal: combined, cleanup: () => undefined };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("Operation aborted")); };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HindsightClient {
  private lastToken: string | undefined;
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
    this.lastToken = token;
    return token;
  }

  private async tokenChanged(previous: string): Promise<boolean> {
    if (this.fixedToken !== undefined) return false;
    try {
      const current = (await fs.readFile(this.config.apiTokenFile, "utf8")).trim();
      if (!current || current === previous) return false;
      this.lastToken = current;
      return true;
    } catch { return false; }
  }

  async requestJson<T>(method: string, url: string, body?: unknown, signal?: AbortSignal, timeoutMs = this.config.requestTimeoutMs): Promise<T> {
    let token = await this.token();
    let authRetry = false;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${method} ${url}: request exceeded ${timeoutMs} ms`);
      const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
      const request: RequestInit = { method, headers };
      if (body !== undefined) { headers["Content-Type"] = "application/json"; request.body = JSON.stringify(body); }
      const combined = combineSignals(signal, remaining);
      request.signal = combined.signal;
      let response: Response;
      try {
        response = await this.fetcher(url, request);
      } catch (error) {
        combined.cleanup();
        if (attempt < 2 && !signal?.aborted && Date.now() < deadline) {
          await sleep(Math.min(100 * 2 ** attempt, Math.max(0, deadline - Date.now())), signal);
          continue;
        }
        throw new Error(`${method} ${url}: ${errorMessage(error)}`);
      }
      combined.cleanup();
      if (response.status === 401 && !authRetry && await this.tokenChanged(token) && Date.now() < deadline) {
        token = await this.token();
        authRetry = true;
        continue;
      }
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!text) return undefined as T;
        try { return JSON.parse(text) as T; }
        catch { throw new Error(`${method} ${url}: server returned invalid JSON`); }
      }
      const responseBody = await response.text();
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (isRetryableStatus(response.status) && attempt < 2 && !signal?.aborted && Date.now() < deadline) {
        const requestedWait = response.status === 429 ? Math.min(retryAfterMs ?? 1000, 10_000) : 100 * 2 ** attempt;
        const wait = Math.min(requestedWait, Math.max(0, deadline - Date.now()));
        await sleep(wait, signal);
        continue;
      }
      if (response.status === 429) throw new HindsightRateLimitError(response.status, method, url, responseBody, retryAfterMs);
      throw new HindsightHttpError(response.status, method, url, responseBody, retryAfterMs);
    }
    throw new Error(`${method} ${url}: request retry limit exceeded`);
  }

  async ensureBank(signal?: AbortSignal): Promise<void> {
    if (this.bankEnsured) return;
    const url = this.bankUrl("/profile");
    try { await this.requestJson("GET", url, undefined, signal); this.bankEnsured = true; return; }
    catch (error) {
      if (!(error instanceof HindsightHttpError) || error.status !== 404) throw error;
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
      if (typeof config.retain_mission !== "string" || !config.retain_mission.includes("global")) throw new Error("Hindsight global retain mission is missing");
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
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
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

  async waitForOperation(operationId: string, signal?: AbortSignal, timeoutMs = this.config.operationPollTimeoutMs): Promise<HindsightOperation> {
    const started = Date.now();
    for (;;) {
      const operation = await this.getOperation(operationId, signal);
      const status = String(operation.status ?? "").toLowerCase();
      if (["not_found", "not found", "404"].includes(status)) {
        throw new HindsightHttpError(404, "GET", this.bankUrl(`/operations/${encodeURIComponent(operationId)}`), "");
      }
      if (["completed", "failed", "cancelled", "error"].includes(status)) {
        if (status !== "completed") throw new Error(`Hindsight operation ${operationId} ended ${status}: ${operation.error_message ?? "unknown error"}`);
        return operation;
      }
      if (signal?.aborted) throw new Error(`Hindsight operation ${operationId} was aborted`);
      if (Date.now() - started >= timeoutMs) throw new Error(`Hindsight operation ${operationId} exceeded ${timeoutMs} ms`);
      await sleep(Math.min(this.config.operationPollMs, Math.max(1, timeoutMs - (Date.now() - started))), signal);
    }
  }

  async dryRunExtract(content: string, overrides: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!content.trim()) throw new Error("dry-run extraction content must not be empty");
    return this.requestJson<Record<string, unknown>>("POST", this.bankUrl("/memories/dry-run-extract"), { content, context: "Global coding-agent session", ...overrides }, signal, this.config.dryRunTimeoutMs ?? 5 * 60 * 1000);
  }

  async recall(query: string, signal?: AbortSignal): Promise<RecallResponse> {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("memory_search query must not be empty");
    if (estimateTokens(trimmed) > 500) throw new Error("memory_search query is longer than Hindsight's 500-token limit");
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
    const ids = new Set<string>();
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const response = await this.requestJson<{ items?: Array<{ id?: string; document_id?: string }>; total?: number }>("GET", this.bankUrl(`/documents?limit=${limit}&offset=${offset}`), undefined, signal);
      const items = response.items ?? [];
      for (const item of items) { const id = item.id ?? item.document_id; if (id) ids.add(id); }
      if (items.length < limit || response.total !== undefined && ids.size >= response.total) break;
    }
    return ids;
  }

  async cancelOperation(operationId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.requestJson("DELETE", this.bankUrl(`/operations/${encodeURIComponent(operationId)}`), undefined, signal);
      return true;
    } catch (error) {
      if (error instanceof HindsightHttpError && error.status === 409) return false;
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
