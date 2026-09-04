# Testing and verification

## Automated tests

```bash
npm run check
npm test
```

Tests use temporary directories and mocked Hindsight clients. They do not use the configured production bank.

The suite covers:

- deterministic canonical rendering and size bounds;
- credential redaction and compact action formatting;
- Pi, Codex, Claude Code, and OpenCode adapters;
- active JSONL tails and malformed completed records;
- generated-memory and memory-assisted evidence handling;
- subagent, ambiguous, and configured-exclusion classification;
- OpenCode read-only transactions and schema drift;
- mutable-document generation serialization and retry IDs;
- approval and budget enforcement;
- Hindsight request shapes, retries, deadlines, and recall formatting;
- configurable weak-result filtering;
- scanner, worker, cleanup, and readiness transitions;
- generic configuration, provider rollback, and service installation;
- active-session settling and forced final scans;
- versioned status integration without credential exposure.

GitHub Actions runs the suite on macOS ARM64 and Ubuntu with supported Node.js versions.

## Live contract tests

Run the isolated no-LLM contract test after starting a new deployment:

```bash
scripts/live-contract-smoke.sh
```

It creates a temporary bank, retains and replaces synthetic content, checks recall, and removes the bank.

## Corpus evaluation

Retrieval quality depends on the imported corpus, extraction model, embedding model, and reranker. Before Pi activation:

1. ask representative answerable questions;
2. ask invented or absent questions;
3. verify source provenance;
4. check correction and temporal cases;
5. measure warm and cold latency;
6. adjust `hindsight.minRelevanceScore` only from this evidence.

Keep private questions and results out of Git. A non-empty nearest-neighbor response is not proof of a match.

## Full-import checks

Before activation, `verify-import` and `verify-ready` enforce document accounting, queue state, Hindsight operation state, consolidation state, and bank configuration. Also create and restore-test a PostgreSQL and SQLite backup pair.
