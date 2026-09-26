# Configuration

The importer, Pi extension, and CLI use the same configuration loader. The default file is `$XDG_CONFIG_HOME/pi-hindsight-memory/config.json`, or `~/.config/pi-hindsight-memory/config.json` when XDG_CONFIG_HOME is not set.

## Inspect and validate

These commands are offline. They do not create importer state, contact Hindsight, or read token contents.

```bash
node dist/src/importer/cli.js config --defaults
node dist/src/importer/cli.js config --config /path/to/config.json
node dist/src/importer/cli.js config --check --config /path/to/config.json
```

- `--defaults` shows built-in settings with paths resolved for the current home and source directories. It does not read the configuration file.
- `config` shows the effective configuration. It includes paths and URLs, so review it before sharing.
- `--check` validates the file and environment overrides. It returns a nonzero exit code on an error.
- A missing default file uses defaults. An explicitly selected file must exist.

Priority:

```text
built-in defaults → JSON file → environment overrides
```

`--config FILE` selects the file before `PI_HINDSIGHT_CONFIG`. Nested objects merge with their defaults. Unknown keys, wrong types, empty paths, invalid URLs, and invalid numeric limits are rejected. For example, `requestTimoutMs` is an error, not an ignored setting.

After changing settings, restart the importer and fully exit and restart Pi. Do not use `/reload` as an upgrade procedure.

## Example

A small file is sufficient. Omitted settings retain their defaults.

```json
{
  "scanIntervalSeconds": 900,
  "sessionSettleSeconds": 3600,
  "maxInflightDocuments": 4,
  "sessionExclusions": { "exactLabels": ["excluded-session"] },
  "importer": {
    "retryDelayMs": 30000,
    "maxAttempts": 3,
    "workBatchSize": 1000
  },
  "hindsight": {
    "apiUrl": "http://127.0.0.1:8888",
    "uiUrl": "http://127.0.0.1:9999",
    "bankId": "coding-history"
  }
}
```

## Import settings

| Key | Default | Purpose |
| --- | --- | --- |
| `scanIntervalSeconds` | 900 | Interval between successful full scans. |
| `sessionSettleSeconds` | 3600 | Time a source fingerprint must remain stable before import. Zero disables settling. |
| `maxInflightDocuments` | 4 | Maximum concurrent document workers. This does not set server-side LLM concurrency. |
| `maxCanonicalBytes` | 104857600 | Maximum normalized document size in bytes (100 MiB). |
| `requireImportApproval` | true | Require provider, privacy, and budget approval before import. Keep enabled for normal use. |
| `sessionExclusions.exactLabels` | `[]` | Exact normalized session labels to exclude. See [setup](SETUP-GUIDE.md). |
| `importer.retryDelayMs` | 30000 | Delay after a failed daemon cycle. |
| `importer.maxAttempts` | 3 | Maximum attempts for a failed generation. Submitted operations remain recoverable. |
| `importer.workBatchSize` | 1000 | Maximum candidates selected per worker pass. The concurrency limit still applies. |

Increasing `maxAttempts` can make exhausted failures eligible again. Review the root cause and budget first. The same limit applies to queue counts, candidate selection, and execution. `retry-failed` remains an explicit reset command.

Counters, sizes, and time values must be safe positive integers, except documented zero values. Internal file-format offsets, HTTP codes, redaction policy, identity rules, and output safety bounds are named constants, not user settings.

## Hindsight client settings

All keys below are inside `hindsight`.

| Key | Default | Purpose |
| --- | --- | --- |
| `apiUrl` | `http://127.0.0.1:8888` | API base URL. |
| `uiUrl` | `http://127.0.0.1:9999` | Status link target. |
| `bankId` | `coding-history` | Letters, digits, hyphens, and underscores only. |
| `requestTimeoutMs` | 15000 | Overall HTTP request deadline, including retries. |
| `statusTimeoutMs` | 4000 | Status-provider request budget. Consumers need a compatible timeout. |
| `httpMaxAttempts` | 3 | Maximum HTTP attempts, including the first request and any authentication retry. |
| `httpRetryDelayMs` | 100 | Initial exponential retry delay. |
| `httpMaxRetryDelayMs` | 10000 | Delay cap, also applied to `Retry-After`. The request deadline still applies. |
| `dryRunTimeoutMs` | 300000 | Dry-run extraction request deadline. |
| `retainWallTimeoutMs` | 86400000 | Maximum retain processing window (24 hours). |
| `operationPollMs` | 5000 | Remote operation polling interval. |
| `operationPollTimeoutMs` | 3600000 | Default operation wait and drain window (one hour). |
| `recallMaxTokens` | 2500 | Derived memory token budget. Zero is allowed. |
| `recallChunksMaxTokens` | 2500 | Original chunk token budget. Zero is allowed. |
| `recallSourceFactsMaxTokens` | 1500 | Supporting fact token budget. Zero is allowed. |
| `minRelevanceScore` | 0.01 | Non-negative relevance filter. This is not a confidence score. |
| `operationRetentionDays` | 14 | Retention policy metadata; zero is allowed. Changing this value alone does not change the server's environment. |

URLs must be valid HTTP or HTTPS URLs without embedded credentials, queries, or fragments. Use the token file for API authentication. Millisecond timeouts must not exceed Node's timer limit (2147483647 ms). The maximum retry delay must be at least the initial retry delay.

Provider, model, reasoning effort, server concurrency, and server retention are separate deployment settings. Use the [provider guide](PROVIDER-GATE.md) and [deployment guide](DEPLOYMENT.md). Do not put provider credentials or model settings into arbitrary `config.json` keys.

## Paths

Run `config --defaults` for the exact paths on the current machine. All path settings accept `~`; relative paths resolve from the working directory.

- `sourceRoots.pi`, `sourceRoots.codex`, `sourceRoots.claude`, `sourceRoots.opencode`: source directories.
- `codexStateDatabase`, `opencodeDatabase`: source databases.
- `stateDirectory`, `stateDatabase`, `evidenceDatabase`, `reportDirectory`, `spoolDirectory`: private importer state.
- `approvalFile`, `reviewedFactsFile`: private approval and reviewed evidence.
- `hindsight.apiTokenFile`, `hindsight.environmentFile`: authentication file and provider metadata file.

Each path is independent. If you move the state directory, update the related database, report, and spool paths as well. Never point a second importer at the same state directory.

## Environment overrides

| Variable | Setting |
| --- | --- |
| `PI_HINDSIGHT_CONFIG` | Configuration file selection. |
| `PI_HINDSIGHT_API_URL` | `hindsight.apiUrl` |
| `PI_HINDSIGHT_UI_URL` | `hindsight.uiUrl` |
| `PI_HINDSIGHT_BANK_ID` | `hindsight.bankId` |
| `PI_HINDSIGHT_API_TOKEN_FILE` | `hindsight.apiTokenFile` |
| `PI_HINDSIGHT_MAX_INFLIGHT` | `maxInflightDocuments` |
| `PI_HINDSIGHT_SCAN_INTERVAL` | `scanIntervalSeconds` |
| `PI_HINDSIGHT_SETTLE_SECONDS` | `sessionSettleSeconds` |
| `PI_HINDSIGHT_REQUIRE_APPROVAL` | `1` for true or `0` for false. Other values are errors. |

`PI_CODING_AGENT_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_DATA_HOME` affect default source paths. Explicit JSON paths take priority over those defaults. Service managers do not automatically inherit terminal environment changes; use the installed configuration file for persistent settings.

`--max-ms` is also bounded by the Node timer limit.

CLI options are command-specific. Unknown or repeated options, missing values, unexpected positional arguments, and invalid numeric limits fail before work starts. Use `--help` to list commands. Use `--` before a positional filename that starts with a hyphen.
