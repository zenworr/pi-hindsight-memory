# Architecture

## Components

### Pi extension

`src/extension/index.ts` registers one tool, `memory_search`, after Pi emits `session_start`. Deferred registration is required because supported Pi versions do not expose the final tool registry while extensions load. Registration refuses to replace an existing `memory_search` tool.

The extension has no `before_agent_start`, `context`, or before-turn retrieval handler. It does not start a process, socket, watcher, timer, or ingestion task. The importer daemon owns background work.

The extension also provides a versioned, non-agent status interface on Pi's shared event bus:

```text
channel: pi-hindsight-memory:status:request:v1
request: { protocolVersion: 1, respond(Promise<snapshot>) }
```

The sanitized snapshot contains configured URLs, bank identity, importer generation counts, service health, document and operation counts, consolidation state, and bounded issue text. It never contains the API token, provider credentials, transcript text, or recalled memory. Status collection occurs only when another extension requests it, so status bars do not need direct access to Hindsight secrets, HTTP details, or importer SQLite schema.

### Importer

The importer runs outside Pi. One periodic scanner handles all four agents, renders the same canonical format, compares hashes, and queues asynchronous Hindsight operations. A changed session fingerprint must remain unchanged across scanner observations for the configured settle delay before normal processing; an explicit forced scan bypasses that delay for final catch-up.

Its SQLite state database records desired generations, acknowledged remote hashes and policy versions, operation state, scan errors, and a daemon heartbeat. It does not replace native histories.

Pending operations have immutable redacted payload files. Preparation, deletion during reviewed repair, submission, and completion use durable checkpoints. A failed operation keeps its payload for retry. Successful operations remove it. These background writes do not run in Pi's foreground lifecycle.

A separate SQLite FTS5 index stores source-linked transcript passages for explicit retrieval. It can be rebuilt without model calls. Reviewed current facts are optional, dated administrative records; they are not inferred automatically.

### Hindsight

Hindsight stores facts, observations, relationships, documents, chunks, and source metadata in one configured bank. The default bank ID is `coding-history`. Every retain uses:

- one named `conversation` strategy
- `update_mode: replace`
- caller-supplied `document_id`
- caller-supplied deterministic `operation_id`
- `observation_scopes: shared`

Cost planning treats `replace` as full reprocessing. Correctness does not depend on unchanged-chunk optimizations.

## Search flow

```text
model calls memory_search
          │
          ▼
POST /v1/default/banks/<configured-bank>/memories/recall
          │
          ▼
world + experience + observation results
          │
          ├── local transcript passages
          └── optional reviewed facts
          │
          ▼
bounded text with explicit provenance and recording dates
```

The formatter does not call `reflect`. Hindsight result scores are relative. The formatter rejects results below the configurable `hindsight.minRelevanceScore` floor.

## Session identity

```text
agent-session:<source>:<native-session-id>
```

A fallback identifier is derived from source, source-relative locator, and stable start timestamp. A locator alias is persisted so a provisional fallback identity can remain stable when a native header becomes readable later.

No session is final. A later scan can replace the same document after an old session resumes.

## Failure boundaries

- A source parsing failure affects one source session, not the daemon.
- An Hindsight outage leaves the generation queued or failed for retry.
- A stale or missing source document is retained in Hindsight.
- A lost response retries the same immutable payload and operation ID.
- A terminal failure, content reversion, or reviewed policy repair gets a fresh replay identity.
- An uncertain remote outcome continues to block newer versions of that document.
- Idle import cycles verify remote document accounting and hashes, so divergence is not hidden behind an empty queue.
