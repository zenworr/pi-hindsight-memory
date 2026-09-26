# Testing and verification

## Automated tests

Install ShellCheck with the system package manager first. On macOS, use `brew install shellcheck`. CI uses ShellCheck from the Ubuntu runner.

```bash
npm ci
npm run validate
npm run deps:audit
```

`npm run release:check` runs both validation and the security audit. `npm publish` also runs this gate through `prepublishOnly`. Validation does not need a running Hindsight service. The audit contacts the npm registry and fails on any reported vulnerability, including development dependencies. Do not use `npm audit fix --force` without reviewing compatibility.

| Command | Check |
| --- | --- |
| `npm run check` | Strict TypeScript, unused symbols, missing returns, and switch fallthrough. |
| `npm run lint` | Type-aware ESLint with zero warnings, safe promises, type imports, module boundaries, and named numeric policies. |
| `npm run lint:shell` | ShellCheck, including sourced shell files. |
| `npm run deps:check` | Installed dependency integrity; unused files, exports, and dependencies; unresolved imports; dependency cycles. |
| `npm run check:docs` | Local Markdown links and code fences. |
| `npm test` | Build and run all unit and integration tests. |
| `npm run check:package` | Version/lockfile agreement, exact direct dependency pins, required package files, and a package allowlist. Run after a build. |
| `npm run deps:audit` | Current npm security advisories. Requires network access. |

Use `npm run lint:fix` for safe lint fixes, then review the diff. Do not disable a failing rule without a specific reason. Production code has no `any` or unsafe-value exceptions. Tests permit partial SDK/HTTP mocks; Node's test registration is a known safe promise call. Synchronous SQLite adapter methods keep the shared async contract. Sanitized tool errors deliberately omit potentially secret-bearing causes.

Numeric policies must use named constants or descriptive configuration keys. Structural zero/one values, array indexes, numeric type literals, and synthetic test values are exempt. Protocol codes, identity layout, and output bounds stay internal. Only useful operational controls become user settings.

Tests use temporary directories and mocked Hindsight clients. They do not use the configured production bank.

The suite covers:

- deterministic canonical rendering and size bounds;
- credential redaction and compact action formatting;
- Pi, Codex, Claude Code, and OpenCode adapters;
- active JSONL tails and malformed completed records;
- generated-memory and memory-assisted evidence handling;
- subagent, ambiguous, and configured-exclusion classification;
- OpenCode read-only transactions and schema drift;
- mutable-document ordering across shutdown, lost responses, source removal, and content reversion;
- immutable pending payloads, terminal-failure retry IDs, and repair checkpoints;
- live Pi SDK startup and repeated reloads without automatic retrieval;
- approval and budget enforcement;
- Hindsight request shapes, retries, deadlines, and recall formatting;
- configurable weak-result filtering;
- local evidence lookup, dated reviewed records, provenance labels, and retrieval during Hindsight outages;
- scanner, worker, cleanup, and readiness transitions;
- generic configuration, provider rollback, and service installation;
- active-session settling and forced final scans;
- versioned status integration without credential exposure.

GitHub Actions runs the suite and package checks on macOS ARM64 and Ubuntu with Node 22 and 24. A separate job runs lint, dependency, documentation, and security checks. Actions are pinned to commit hashes. Dependabot opens weekly update PRs for npm packages and Actions; a weekly audit also checks unchanged lockfiles for new advisories.

The regression suite checks invalid CLI/configuration inputs, offline configuration validation, retry controls, and queue counts with non-default attempt limits. These checks must pass before release.

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

Before activation, `verify-ready` checks `activationReady`: document identities and hashes, desired versus acknowledged state, source errors and deferrals, Hindsight operation and consolidation state, and bank configuration. `continuousReady` also requires a live, unpaused importer without a recorded cycle error. Check the configured recovery mechanism separately.

Historical policy changes require a bounded, source-backed quality pilot before [historical repair](HISTORICAL-REPAIR.md). Do not infer quality from a completed consolidation queue.
