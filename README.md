# pi-hindsight-memory

Global, provenance-preserving memory for the Pi coding agent, backed by a local [Hindsight](https://github.com/vectorize-io/hindsight) service.

It imports existing Pi, Codex, Claude Code, and OpenCode sessions into one Hindsight bank and keeps mutable sessions up to date. Pi receives one explicit retrieval tool:

```text
memory_search({ query: string })
```

Memory is never injected automatically.

## Supported hosts

- macOS on Apple Silicon with Docker Desktop
- Linux on x86-64 or ARM64 with Docker or Podman
- Node.js 22.19 or newer

The Hindsight and pgvector images have native AMD64 and ARM64 variants.

## Data flow

```text
Pi / Codex / Claude Code / OpenCode histories
                         │
                         ▼
              read-only source adapters
                         │
                         ▼
             redacted canonical sessions
                         │
                         ▼
        local Hindsight + PostgreSQL containers
                         │
                         ▼
               Pi memory_search tool
```

## Quick start

Do not install the Pi extension yet.

```bash
git clone https://github.com/zenworr/pi-hindsight-memory.git
cd pi-hindsight-memory
scripts/setup.sh
```

The setup script builds and tests the project, creates private local configuration, starts a no-LLM smoke deployment, and runs an isolated contract test. It does not configure an API key or import real sessions.

Continue with the step-by-step [setup guide](docs/SETUP-GUIDE.md).

## Configuration

The main configuration is:

```text
~/.config/pi-hindsight-memory/config.json
```

It controls:

- Hindsight URL and bank ID;
- all four session locations;
- the Codex and OpenCode databases;
- exact session-label exclusions;
- scan interval, import concurrency, and weak-result relevance floor;
- state, spool, report, and approval locations.

Provider secrets are separate:

```text
~/.config/pi-hindsight-memory/hindsight.env
```

Use `scripts/configure-provider.sh --model MODEL_ID` to set an OpenAI or OpenAI-compatible API key without placing the key in the repository or shell history. The provider defaults to `openai-responses`; the model and optional reasoning effort are explicit operator choices and must be supported by the selected endpoint.

Session exclusions default to an empty list. Matching uses Unicode NFKC normalization, trimming, and case-insensitive exact equality. It never uses substrings, globs, working directories, project names, or transcript inspection.

## Safe staged import

```text
Existing Pi configuration stays unchanged
          ↓
No-LLM smoke test
          ↓
Provider test and bounded pilot
          ↓
Historical import with automatic consolidation off
          ↓
Final catch-up, consolidation, verification, and backup
          ↓
Activate the Pi extension after readiness checks
          ↓
Continuous scanner and automatic consolidation on
```

A stopped or interrupted import is resumable. Caller-owned operation IDs and the local state database prevent duplicate processing.

## Safety properties

- Source histories are opened read-only and are never modified.
- Active JSONL tails are retried instead of treated as complete records.
- Sessions use stable mutable document IDs.
- Credentials are redacted before provider requests.
- Raw tool results, hidden reasoning, generated memory, injected context, and retrieved memory are excluded as evidence.
- Structural subagents are excluded before canonicalization.
- Unknown child-session shapes fail closed as ambiguous.
- Hindsight and its UI bind only to loopback by default.
- PostgreSQL has no host port.
- Import requires an approved provider, privacy mode, token budget, cost budget, disk floor, and failure-rate limit.
- Pi installation backs up settings and automatically restores them if installation fails.

## Development

```bash
npm ci
npm run check
npm test
```

See also:

- [Architecture](docs/ARCHITECTURE.md)
- [Canonical format](docs/CANONICAL-FORMAT.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Testing](docs/TESTING.md)
