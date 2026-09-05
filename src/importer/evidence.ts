import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, CanonicalSession, CanonicalTurn } from "../common/types.js";
import { forEachJsonLine } from "../adapters/adapter.js";
import { redactText } from "../canonical/redact.js";

export interface EvidenceHit {
  documentId: string;
  source: string;
  sessionId: string;
  sourcePath: string;
  entryId: string;
  parentEntryId?: string;
  role: string;
  provenance: string;
  timestamp: string;
  text: string;
  indexedAt: string;
}

const STOP_WORDS = new Set("a an and are as at be been but by can could did do does for from had has have how i in is it its me my of on or our please should that the their these they this those to was we were what when where which who why will with would you your current currently latest now still about tell know information method use used uses using".split(" "));

export function queryTerms(query: string): string[] {
  return [...new Set((query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))].slice(0, 16);
}

function matchedTerms(text: string, terms: string[]): number {
  const normalized = text.normalize("NFKC").toLowerCase();
  const words = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []);
  return terms.filter((term) => term.includes("-") ? normalized.includes(term) : words.has(term)).length;
}

function* passageTexts(content: string): Iterable<string> {
  let heading = "";
  let label = "";
  for (const paragraph of content.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    if (/^#{1,6} [^\n]+$/.test(paragraph)) { heading = paragraph; label = ""; continue; }
    if (paragraph.length < 180 && !paragraph.includes("\n") && paragraph.endsWith(":")) { label = paragraph; continue; }
    for (let offset = 0; offset < paragraph.length; offset += 1600) yield [heading, label, paragraph.slice(offset, offset + 2000)].filter(Boolean).join("\n\n");
    label = "";
  }
}

function writableIndex(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY,source TEXT NOT NULL,session_id TEXT NOT NULL,source_path TEXT NOT NULL,canonical_hash TEXT NOT NULL,indexed_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(text,document_id UNINDEXED,entry_id UNINDEXED,parent_entry_id UNINDEXED,role UNINDEXED,provenance UNINDEXED,timestamp UNINDEXED,tokenize='unicode61');
  `);
  for (const name of [file, `${file}-wal`, `${file}-shm`]) { if (fs.existsSync(name)) fs.chmodSync(name, 0o600); }
  return db;
}

export async function indexEvidence(config: AppConfig, session: CanonicalSession, force = false): Promise<void> {
  if (session.classification?.kind !== "primary") return;
  if (session.emptyAfterNormalization) { removeEvidence(config, session.documentId); return; }
  const db = writableIndex(config.evidenceDatabase);
  try {
    const prior = db.prepare("SELECT canonical_hash FROM documents WHERE id=?").get(session.documentId) as { canonical_hash: string } | undefined;
    if (prior?.canonical_hash === session.canonicalHash && !force) {
      db.prepare("UPDATE documents SET source_path=? WHERE id=?").run(redactText(session.metadata.source_path).text, session.documentId);
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    if (prior) db.prepare("DELETE FROM passages WHERE document_id=?").run(session.documentId);
    db.prepare("INSERT INTO documents(id,source,session_id,source_path,canonical_hash,indexed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path,canonical_hash=excluded.canonical_hash,indexed_at=excluded.indexed_at").run(session.documentId, session.source, session.nativeSessionId, redactText(session.metadata.source_path).text, session.canonicalHash, new Date().toISOString());
    const insert = db.prepare("INSERT INTO passages(text,document_id,entry_id,parent_entry_id,role,provenance,timestamp) VALUES (?,?,?,?,?,?,?)");
    await forEachJsonLine(session.contentPath, (raw) => {
      const turn = raw as CanonicalTurn;
      if (!["user", "assistant"].includes(turn.role)) return;
      for (const text of passageTexts(turn.content)) insert.run(text, session.documentId, turn.native_entry_id ?? "", turn.parent_entry_id ?? null, turn.role, turn.provenance ?? "original", turn.timestamp);
    });
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve the index error */ } throw error; }
  finally { db.close(); }
}

export function indexedDocumentHashes(config: AppConfig): Map<string, string> {
  if (!fs.existsSync(config.evidenceDatabase)) return new Map();
  const db = new DatabaseSync(config.evidenceDatabase, { readOnly: true, timeout: 500 });
  try { return new Map((db.prepare("SELECT id,canonical_hash FROM documents").all() as Array<{ id: string; canonical_hash: string }>).map((row) => [row.id, row.canonical_hash])); }
  finally { db.close(); }
}

export function removeEvidence(config: AppConfig, documentId: string): void {
  if (!fs.existsSync(config.evidenceDatabase)) return;
  const db = writableIndex(config.evidenceDatabase);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM passages WHERE document_id=?").run(documentId);
    db.prepare("DELETE FROM documents WHERE id=?").run(documentId);
    db.exec("COMMIT");
  } finally { db.close(); }
}

export function searchEvidence(config: AppConfig, query: string): { available: boolean; hits: EvidenceHit[] } {
  if (!fs.existsSync(config.evidenceDatabase)) return { available: false, hits: [] };
  const terms = queryTerms(query);
  if (!terms.length) return { available: true, hits: [] };
  const db = new DatabaseSync(config.evidenceDatabase, { readOnly: true, timeout: 500 });
  try {
    const quoted = (term: string) => `"${term.replaceAll('"', '""')}"`;
    const expression = terms.map(quoted).join(" OR ");
    const proper = new Set((query.match(/\b[A-Z][A-Za-z0-9_-]+\b/g) ?? []).map((term) => term.toLowerCase()));
    const calendar = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" "));
    const explicit = terms.filter((term) => proper.has(term) && !calendar.has(term) || /\d{3}/.test(term));
    const candidates = explicit.length ? explicit : terms;
    const frequency = db.prepare("SELECT count(DISTINCT document_id) AS count FROM passages WHERE passages MATCH ?");
    const anchors = candidates.map((term) => ({ term, count: Number((frequency.get(quoted(term)) as { count: number }).count) })).filter((item) => item.count > 0).sort((a, b) => a.count - b.count);
    const anchor = quoted(anchors[0]?.term ?? terms[0]!);
    const recent = /\b(current|latest|now|still|recent|today|final|correction|removed|retired)\b/i.test(query) && !/\b(before|previous|originally|historical)\b/i.test(query);
    const read = (order: string) => (db.prepare(`SELECT p.document_id AS documentId,d.source,d.session_id AS sessionId,d.source_path AS sourcePath,p.entry_id AS entryId,p.parent_entry_id AS parentEntryId,p.role,p.provenance,p.timestamp,p.text,d.indexed_at AS indexedAt FROM passages p JOIN documents d ON d.id=p.document_id WHERE passages MATCH ? AND p.document_id IN (SELECT document_id FROM passages WHERE passages MATCH ?) ORDER BY ${order} LIMIT 100`).all(expression, anchor) as unknown as EvidenceHit[])
      .filter((row) => matchedTerms(row.text, terms) >= Math.min(2, terms.length));
    const lexical = read("rank");
    const latest = recent ? read("p.timestamp DESC,rank") : [];
    const corrections = latest.filter((row) => /\b(correction|superseded|no longer|removed|retired)\b/i.test(row.text));
    const rows = recent ? [...corrections.slice(0, 2), ...lexical.slice(0, 2), ...latest, ...lexical] : lexical;
    const hits: EvidenceHit[] = [];
    const excerpts = new Set<string>();
    const perEntry = new Map<string, number>();
    const perDocument = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.documentId}:${row.entryId}`;
      const excerpt = `${key}:${row.text}`;
      if (excerpts.has(excerpt) || (perEntry.get(key) ?? 0) >= 2 || (perDocument.get(row.documentId) ?? 0) >= 3) continue;
      excerpts.add(excerpt);
      perEntry.set(key, (perEntry.get(key) ?? 0) + 1);
      perDocument.set(row.documentId, (perDocument.get(row.documentId) ?? 0) + 1);
      hits.push(row);
      if (hits.length === 6) break;
    }
    return { available: true, hits };
  } finally { db.close(); }
}

export interface ReviewedFact {
  key: string;
  text: string;
  verifiedAt: string;
  source: string;
  supersedes?: string;
}

export function reviewedFacts(config: AppConfig, query: string): ReviewedFact[] {
  if (!fs.existsSync(config.reviewedFactsFile)) return [];
  if (fs.statSync(config.reviewedFactsFile).size > 64 * 1024) throw new Error("Reviewed facts exceed 64 KiB");
  const facts: unknown = JSON.parse(fs.readFileSync(config.reviewedFactsFile, "utf8"));
  if (!Array.isArray(facts)) throw new Error("Reviewed facts must be an array");
  const terms = queryTerms(query);
  return facts.filter((fact): fact is ReviewedFact => {
    if (!fact || typeof fact.key !== "string" || typeof fact.text !== "string" || typeof fact.source !== "string" || typeof fact.verifiedAt !== "string" || !Number.isFinite(Date.parse(fact.verifiedAt))) throw new Error("Invalid reviewed fact; require key, text, source, and verifiedAt");
    const text = `${fact.key} ${fact.text}`.toLowerCase();
    return matchedTerms(text, terms) >= Math.min(2, terms.length) && terms.length > 0;
  }).slice(0, 4).map((fact) => ({ key: fact.key, text: redactText(fact.text).text, source: redactText(fact.source).text, verifiedAt: fact.verifiedAt, ...(typeof fact.supersedes === "string" ? { supersedes: redactText(fact.supersedes).text } : {}) }));
}
