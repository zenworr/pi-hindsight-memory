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
- `memory-assisted` on assistant prose that follows a memory search on the same branch

## Excluded

- hidden reasoning
- raw tool output
- tool-result messages
- system and developer instructions
- injected AGENTS or memory context
- generated memory-system output and memory-search results
- generated compaction and branch summaries
- telemetry, token counts, usage, and status records
- base64 and file payloads
- OpenCode reasoning, step, and file parts

This is normalization, not manual memory approval. It makes old and new sessions use the same input type.

## Streaming

Adapters stream source JSONL and write a temporary canonical spool. They do not call `readFile()` on an entire native source file. A line without a terminating newline is provisional and is ignored until the next scan, even when its JSON syntax is valid. A malformed newline-terminated line fails closed.

Canonical output is bounded before it is handed to the Hindsight client. The default limit is 100 MiB. The importer reports an explicit `too_large` result instead of silently truncating visible content.

## Redaction

A redacted copy is sent to Hindsight. Native source data stays unchanged. The policy detects common API keys, bearer headers, cookies, private-key blocks, URL/database passwords, cloud keys, and secret-like environment assignments. Replacement markers identify the rule. Logs contain only a count.

## Source cleanup policy

The importer never deletes a Hindsight document because a source file or OpenCode row disappears. It marks the state as `source_missing`. It also keeps the previous Hindsight document when a previously imported session temporarily normalizes to only its REF-ID line. This avoids destructive action caused by partial writes, source retention cleanup, or parser changes. The importer has no automatic forgetting behavior.
