import type { RecallResponse, RecallResult } from "../common/types.js";

export interface MemorySearchDetails {
  resultCount: number;
  sourceCount: number;
  noMatch: boolean;
  sourceEvidenceCount?: number;
  reviewedFactCount?: number;
  degraded?: boolean;
}

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
// Hindsight returns nearest neighbors even when no evidence matches.
export const DEFAULT_MIN_RELEVANCE_SCORE = 0.01;

function safe(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function shorten(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value.slice(0, Math.max(1, maxBytes - 1));
  while (Buffer.byteLength(result, "utf8") > maxBytes - 1) result = result.slice(0, -1);
  return `${result}…`;
}
function dateOf(result: RecallResult): string { return result.occurred_start ?? result.mentioned_at ?? "date unavailable"; }
function scoreOf(result: RecallResult): string { const score = result.scores?.final; return typeof score === "number" ? `; relative score ${score.toFixed(4)}` : ""; }

function sourceKey(result: RecallResult): string {
  const metadata = result.metadata ?? {};
  return `${metadata.source ?? ""}|${metadata.native_session_id ?? ""}|${metadata.source_path ?? ""}|${result.document_id ?? ""}`;
}

function sourceDescription(result: RecallResult): string {
  const metadata = result.metadata ?? {};
  const source = metadata.source ?? "unknown source";
  const session = metadata.native_session_id ?? result.document_id ?? "unknown document";
  const sourcePath = metadata.source_path;
  return `${source} session ${session}${sourcePath ? ` (${sourcePath})` : ""}`;
}

function sourceEvidence(result: RecallResult, response: RecallResponse): string[] {
  const candidates: RecallResult[] = [result];
  for (const id of result.source_fact_ids ?? []) {
    const fact = response.source_facts?.[id];
    if (fact) candidates.push(fact);
  }
  const descriptions = new Map<string, string>();
  for (const candidate of candidates) {
    const key = sourceKey(candidate);
    if (key !== "|||" && !descriptions.has(key)) descriptions.set(key, sourceDescription(candidate));
  }
  if (descriptions.size > 0) return [...descriptions.values()];
  return [`observation ${result.id ?? "unknown"} (source facts were not returned)`];
}

function excerptFor(result: RecallResult, response: RecallResponse): string | undefined {
  const chunk = result.chunk_id ? response.chunks?.[result.chunk_id] : undefined;
  if (chunk?.text) return chunk.text;
  for (const id of result.source_fact_ids ?? []) {
    const fact = response.source_facts?.[id];
    if (fact?.text) return fact.text;
  }
  return undefined;
}

export function formatRecallResponse(response: RecallResponse, options: { minRelevanceScore?: number } = {}): { text: string; details: MemorySearchDetails } {
  const raw = Array.isArray(response.results) ? response.results : [];
  const minRelevanceScore = options.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE;
  const results: RecallResult[] = [];
  const seen = new Set<string>();
  for (const result of raw) {
    const score = result.scores?.final;
    if (typeof score === "number" && score < minRelevanceScore) continue;
    const key = result.id ?? `${result.type ?? ""}\n${result.text ?? ""}\n${result.document_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key); results.push(result);
    if (results.length === 6) break;
  }
  if (results.length === 0) return { text: "No matching memory evidence was returned. Do not treat this as proof that the information never existed.", details: { resultCount: 0, sourceCount: 0, noMatch: true } };

  const sourceKeys = new Set<string>();
  const lines: string[] = [`Found ${results.length} derived memory match${results.length === 1 ? "" : "es"}. Relevance does not establish that the query is answerable.`];
  results.forEach((result, index) => {
    const sources = sourceEvidence(result, response);
    for (const source of sources) sourceKeys.add(source);
    lines.push("");
    lines.push(`${index + 1}. ${result.type ?? "memory"} — ${dateOf(result)}${scoreOf(result)}`);
    lines.push(`   ${shorten(safe(result.text) || "(empty memory text)", 4_000).replaceAll("\n", "\n   ")}`);
    lines.push("   Sources:");
    for (const source of sources) lines.push(`   - ${source}`);
    const excerpt = excerptFor(result, response);
    if (excerpt && excerpt !== result.text) {
      const label = result.chunk_id && response.chunks?.[result.chunk_id]?.text ? "Transcript excerpt" : "Derived supporting fact (not an original quotation)";
      lines.push(`   ${label}: ${shorten(excerpt, 1_500).replaceAll("\n", " ")}`);
    }
    if (result.source_fact_ids && result.source_fact_ids.length > 0) lines.push(`   Supporting source facts: ${result.source_fact_ids.length}${response.source_facts_truncated ? " (some source facts omitted by budget)" : ""}`);
  });
  lines.push("");
  lines.push("Scores are relative ranking signals, not confidence probabilities.");
  return boundOutput(lines.join("\n"), { resultCount: results.length, sourceCount: sourceKeys.size, noMatch: false });
}

export function boundOutput(text: string, details: MemorySearchDetails): { text: string; details: MemorySearchDetails } {
  const lines = text.split("\n");
  let output = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  let truncated = lines.length > MAX_OUTPUT_LINES;
  const notice = "\n\n[Output truncated to 50 KB or 2,000 lines.]";
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) { output = shorten(output, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8")); truncated = true; }
  if (truncated) {
    if (Buffer.byteLength(output, "utf8") + Buffer.byteLength(notice, "utf8") > MAX_OUTPUT_BYTES) output = shorten(output, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8"));
    output += notice;
  }
  return { text: output, details };
}
