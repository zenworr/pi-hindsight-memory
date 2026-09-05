# Memory retrieval and source evidence

The agent still has one tool: `memory_search({ query })`. It runs only when the agent calls it. There is no automatic retrieval or prompt injection.

```text
memory_search
  ├─ reviewed facts, with source and verification date
  ├─ local transcript excerpts, with session and entry IDs
  └─ Hindsight-derived memories
```

## What the results mean

- A reviewed fact is an administrative record checked at the stated time. It is not a live system check.
- A transcript excerpt shows what the user or assistant said. An assistant report is not independent proof that an action succeeded.
- Memory-assisted reports remain searchable, but are explicitly marked as derived. They must not be counted as independent evidence.
- A Hindsight match is generated from evidence. It can be historical, incomplete, or wrong.
- A recorded timestamp is not necessarily the time of the event being described.

Current user instructions and newer explicit corrections take priority over older reviewed records. Check live configuration for time-sensitive system questions. Related search results do not prove that a question is answerable.

The tool returns up to six transcript excerpts, four matching reviewed facts, and six derived matches. The complete response remains bounded to 50 KiB or 2,000 lines.

## Local index

The importer maintains `evidence.sqlite3` beside its state database. This is a derived FTS5 index, not another memory service. It contains redacted primary-session transcript passages and source references. Native histories are unchanged.

The index does not include tool output, hidden reasoning, or harness startup instructions. Preserved ambiguous sessions remain available through Hindsight; the importer does not read their newer source content into this index.

Queries search globally. An explicit name or identifier can narrow matching passages to relevant documents; this does not create project-specific banks.

If Hindsight is unavailable, matching local evidence remains usable. The result reports the degraded state. Cancellation still cancels the request.

To rebuild the index without sending anything to a model:

```bash
node dist/src/importer/cli.js pause
scripts/importer-service.sh stop
node dist/src/importer/cli.js index-evidence --force
```

This also runs source classification and records current desired hashes. It does not queue retain operations. Review any reported source or classification errors before restarting the importer.

The index is separate from `state.sqlite3`. Never remove the state database to rebuild the index.

## Reviewed facts

The optional `current-facts.json` file is under the configuration directory. It is read only during an explicit memory search. Keep it private and maintain it manually after checking the cited evidence.

```json
[
  {
    "key": "project-harbor-database",
    "text": "Project Harbor uses SQLite.",
    "verifiedAt": "2026-01-02T10:00:00.000Z",
    "source": "Session harbor-planning, user entry decision-2",
    "supersedes": "The earlier PostgreSQL choice."
  }
]
```

Require a concrete source, preserve scope, and use an ISO timestamp with a time zone. Do not promote an assistant suggestion into a reviewed fact. If verification is only a user report, say so. Revise or remove a record when its evidence no longer applies.

The file is limited to 64 KiB. `reviewedFactsFile` and `evidenceDatabase` can be set in the client configuration.

## Evidence policy

The named `conversation` strategy inherits the bank retain mission. The importer checks the effective mission, including any strategy override, before new submissions.

The default policy writes facts in English to match the default English embedding and reranking models. It preserves literal names and values, distinguishes user statements from assistant reports, keeps task and machine scope, and does not invent time zones or infer success from a compact action.

Changing parser, redaction, or extraction policy can require historical repair. See [Historical repair](HISTORICAL-REPAIR.md).
