# Canonical format

The canonical document is UTF-8 JSON Lines. Each line is one normalized turn. Property order is fixed:

```json
{"role":"user","content":"Use PostgreSQL.","timestamp":"2026-01-01T00:00:00.000Z","native_entry_id":"u1","parent_entry_id":"s1","provenance":"original"}
```

Allowed roles:

```text
system | user | assistant | action
```

The first line is:

```json
{"role":"system","content":"REF-ID: agent-session:<source>:<id>","timestamp":"<session start>"}
```

## Included

- visible user text
- visible assistant prose
- compact tool action names and targets
- timestamps
- native entry IDs
- parent IDs for tree-capable formats
- `memory-assisted` on assistant prose after a memory search on the same branch, until a genuine user turn resets the context

## Excluded

- hidden reasoning
- raw tool output
- tool-result messages
- system and developer instructions
- leading harness AGENTS instruction blocks, environment wrappers, and injected memory context
- generated memory-system output and memory-search results
- generated compaction and branch summaries
- telemetry, token counts, usage, and status records
- base64 and file payloads
- OpenCode reasoning, step, and file parts

Some filters recognize named wrappers from older memory extensions. Those names identify input formats; they do not add a runtime dependency or activate another memory system.

This is normalization, not manual memory approval. It makes old and new sessions use the same input type.

## Streaming

Adapters stream source JSONL and write a temporary canonical spool. They do not call `readFile()` on an entire native source file. A line without a terminating newline is provisional and is ignored until the next scan, even when its JSON syntax is valid. A malformed newline-terminated line, including a header, fails closed. Cancellation closes the source stream and unfinished spool.

OpenCode fingerprints hash complete per-session message and part data, not sampled prefixes or suffixes. Its read transaction provides a consistent snapshot while allowing WAL writers to commit. Invalid stored JSON is reported without quoting the record.

Codex label lookup requires a readable configured state database with an ID and a supported name or title column. It does not treat database errors as an empty label map.

Canonical output is bounded before it is handed to the Hindsight client. The default limit is 100 MiB. The importer reports an explicit `too_large` result instead of silently truncating visible content.

## Redaction

A redacted copy is sent to Hindsight. Native source data stays unchanged. The policy detects common API keys, bearer headers, cookies, private-key blocks, URL/database passwords, cloud keys, secret-like assignments, and signed-URL credentials. It also detects Pi-style OAuth JSON objects with `access`, `refresh`, and `expires` in the same object, named OAuth secrets such as `id_token` and `client_secret`, and authorization codes in callback or OAuth URLs and URLs with both `code` and `state`. A replacement marker exempts only a complete value, not a value that contains a marker and additional text. Outbound session metadata uses the same redactor. This policy does not detect every possible credential format or encoded copy of a credential.

### Policy release gate

Before deployment, stop the importer and make a consistent set of private copies. Do not point the report at live state, live source directories, or symlinks to them. Put a standalone SQLite backup of the importer state in a mode-`0600` file. In a mode-`0700` source directory, make one subdirectory for each source origin in the copied state (for example, `desktop`). Under each origin, preserve the relative layouts of the copied Pi sessions in `pi/`, Claude projects in `claude/`, and Codex sessions in `codex/`. Put the standalone Codex label backup at `state_5.sqlite` and the standalone OpenCode backup at `opencode.db` in that origin directory. Use SQLite backups that do not need WAL or rollback-journal files.

```sh
npm run build
node scripts/checks/redaction-impact.mjs --state-copy /path/to/state-copy.sqlite3 --sources-copy /path/to/sources-copy
```

The report uses only the named copies and a private temporary spool. It does not load runtime configuration, contact Hindsight, or queue work. It reports counts of acknowledged documents with changed and unchanged canonical bytes, preserved ambiguous documents that it did not normalize, unavailable sources or unmatched IDs, and errors. It returns a nonzero exit status if the comparison is incomplete. The comparison is against the acknowledged hash, so source edits or other normalization changes in the checkout can contribute to the changed count. Renamed artifacts without a matching native ID are unavailable. Resolve incomplete comparisons and review any nonzero changed count before deployment. The report does not authorize historical replay.

Redaction policy version 4 identifies newly normalized payloads. The importer keeps the existing source scan signature for this redaction change. Unchanged acknowledged source snapshots retain their remote hashes and operation IDs, including when the local evidence index is rebuilt. Sessions already marked as preserved ambiguous are not requeued. New or changed source snapshots use the new rules. A stored payload with an unsupported version remains unresolved if the importer would need to send it again. The importer preserves its files and operation ID, does not retry it, and holds other imports for the same session. It can still acknowledge already completed remote work without resending its payload. Review unresolved operations before any retry or replacement.

This release does not remove existing copies from Hindsight, backups, or the local index. Treat known exposed credentials as compromised and rotate them. Review any historical remote cleanup separately. To refresh the local evidence index without sending documents, use `index-evidence --force`.

## Source cleanup policy

The importer never deletes a Hindsight document because a source file or OpenCode row disappears. It marks the state as `source_missing`. It also keeps the previous Hindsight document when a previously imported session temporarily normalizes to only its REF-ID line. This avoids destructive action caused by partial writes, source retention cleanup, or parser changes. The importer has no automatic forgetting behavior.
