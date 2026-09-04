# Setup guide

This guide creates a new, independent memory installation on one machine. For an always-on Hindsight service with a workstation-side importer, follow this guide through initial validation, then use [REMOTE-DEPLOYMENT.md](REMOTE-DEPLOYMENT.md).

## 1. Install prerequisites

### macOS with Docker Desktop

Use an Apple Silicon version of Docker Desktop. In Docker Desktop settings:

1. enable **Start Docker Desktop when you sign in**;
2. assign at least 8 GB of memory; 12 GB is preferable during import;
3. assign at least 4 CPU cores;
4. keep at least 20 GB free for images before allowing for the memory database.

Install command-line dependencies:

```bash
brew install node jq git
```

Node.js must be version 22.19 or newer:

```bash
node --version
npm --version
docker version
docker compose version
```

The full Hindsight 0.9.2 image and pgvector image have native ARM64 builds. Do not force `linux/amd64` emulation.

### Linux

Install Node.js 22.19 or newer, Git, jq, SQLite, OpenSSL, and either Docker Compose or Podman Compose. Rootless Podman is supported.

## 2. Clone and run the safe base setup

Choose a permanent checkout location without spaces. The Pi package registration and background service refer to this absolute path. Moving or deleting the checkout after activation breaks them until you reinstall both.

```bash
git clone https://github.com/zenworr/pi-hindsight-memory.git
cd pi-hindsight-memory
scripts/setup.sh
```

The first startup downloads the Hindsight image and local embedding/reranking models. It can take several minutes.

The script performs these operations:

```text
install dependencies → build → automated tests → private config
→ no-LLM containers → authenticated health checks → isolated smoke test
```

It does **not** read real transcript text into Hindsight, configure an external API key, install the Pi extension, or change existing Pi settings.

## 3. Review local configuration

Open:

```text
~/.config/pi-hindsight-memory/config.json
```

The defaults are:

```json
{
  "sessionExclusions": { "exactLabels": [] },
  "sessionSettleSeconds": 60,
  "maxInflightDocuments": 4,
  "sourceRoots": {
    "pi": "~/.pi/agent/sessions",
    "codex": "~/.codex/sessions",
    "claude": "~/.claude/projects",
    "opencode": "~/.local/share/opencode"
  },
  "codexStateDatabase": "~/.codex/state_5.sqlite",
  "opencodeDatabase": "~/.local/share/opencode/opencode.db",
  "hindsight": {
    "apiUrl": "http://127.0.0.1:8888",
    "uiUrl": "http://127.0.0.1:9999",
    "bankId": "coding-history",
    "minRelevanceScore": 0.01
  }
}
```

The generated file contains absolute paths instead of `~`. A normal scan defers a changed session until the same fingerprint has been observed unchanged for `sessionSettleSeconds`; this avoids repeatedly replacing a document while an agent is actively writing it. With the default five-minute scan interval, a changed session normally needs two matching observations before ingestion. `minRelevanceScore` is a starting floor for weak nearest-neighbor results, not a confidence value. Adjust it only after testing known and unanswerable queries against the local corpus.

OpenCode documents the same `~/.local/share/opencode` storage location on macOS and Linux. Initial configuration honors `PI_CODING_AGENT_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `XDG_DATA_HOME`. You can also edit any generated path directly.

To exclude known generated sessions, add exact labels only:

```json
"sessionExclusions": {
  "exactLabels": ["label-one", "label-two"]
}
```

Do this before inventory. A later change can require audited Hindsight cleanup.

Do not reuse `state.sqlite3`, PostgreSQL volumes, API tokens, or backup files from another installation.

## 4. Configure the OpenAI API

Choose a model that the target endpoint supports. Replace `MODEL_ID` in the examples below. The secure helper requires that choice and prompts for the key without echoing it:

```bash
scripts/configure-provider.sh --model MODEL_ID
```

The provider defaults to `openai-responses`. Reasoning effort is optional and is not sent unless specified:

```bash
scripts/configure-provider.sh \
  --model MODEL_ID \
  --reasoning medium
```

If the endpoint supports only Chat Completions, use:

```bash
scripts/configure-provider.sh \
  --provider openai \
  --model MODEL_ID
```

For an OpenAI-compatible endpoint:

```bash
scripts/configure-provider.sh \
  --provider openai-responses \
  --base-url https://api.example.invalid/v1 \
  --model MODEL_ID
```

For noninteractive use, `--api-key-env NAME` reads the key from a selected environment variable instead of a command argument.

The key is written to this mode-0600 local file and passed to the Hindsight container:

```text
~/.config/pi-hindsight-memory/hindsight.env
```

If Hindsight does not become healthy, inspect:

```bash
scripts/stack.sh logs hindsight-app
```

Common causes are an unavailable model ID, a wrong base URL, a network proxy requirement, or a provider that does not implement the selected API shape.

Install the extraction bank configuration, with automatic consolidation still disabled:

```bash
scripts/configure-bank.sh --file deploy/compose/bank-config.json
```

## 5. Inventory before any paid extraction

```bash
REPORT="$HOME/.local/state/pi-hindsight-memory/reports/inventory.json"
node dist/src/importer/cli.js inventory --output "$REPORT"
jq '.totals, .bySource' "$REPORT"
```

Inventory reads source files and the OpenCode database, but it does not contact the provider and does not put transcript text in its report.

Check:

- all expected harnesses have sessions;
- malformed and error counts are zero;
- subagent and ambiguous counts are plausible;
- the largest canonical sessions are not unexpectedly large;
- free disk space remains sufficient.

The importer estimates one input token per four canonical bytes. Real provider use can be higher because extraction and consolidation have prompt overhead. Include a planning margin and enforce a provider-side budget when available.

## 6. Create the local approval gate

The importer refuses paid retention without this file. The last two values are provider prices per million input and output tokens:

```bash
MAX_INPUT_TOKENS=YOUR_LIMIT
MAX_COST_USD=YOUR_LIMIT
INPUT_PRICE=YOUR_PROVIDER_INPUT_PRICE_PER_MILLION
OUTPUT_PRICE=YOUR_PROVIDER_OUTPUT_PRICE_PER_MILLION

scripts/create-import-approval.sh \
  "$MAX_INPUT_TOKENS" \
  "$MAX_COST_USD" \
  remote-redacted \
  "$INPUT_PRICE" \
  "$OUTPUT_PRICE"
```

Use approved values. A zero price disables useful cost estimation; use it only when the provider account has no billed cost. The token ceiling remains active either way.

## 7. Run a small extraction pilot

```bash
scripts/run-pilot.sh
```

By default, this chooses at most 20 sessions no larger than 1 MiB each and compares concise and verbose extraction. Optional arguments change the count and size limit. It does not retain the pilot in the production bank. The approval gate bounds its estimated two-mode input.

Review the reported JSON. Stop if there are extraction errors, empty results for clearly durable sessions, leaked credentials, excessive latency, or unexpected provider use.

After review, use the reported pilot file to test real asynchronous retention:

```bash
PILOT="$HOME/.local/state/pi-hindsight-memory/reports/pilot-TIMESTAMP.json"
node dist/src/importer/cli.js queue-pilot "$PILOT"
node dist/src/importer/cli.js process-queued --max-ms 86400000
node dist/src/importer/cli.js status
```

Do not start the continuous importer service yet.

## 8. Run the historical import

Leave the existing Pi configuration unchanged during the complete historical import. Do not install this Pi extension yet.

On macOS, prevent sleep while the terminal command runs:

```bash
caffeinate -dimsu scripts/import-all.sh
```

On Linux:

```bash
scripts/import-all.sh
```

The default run processes cohorts of 250 sessions for at most 24 hours. A cohort is scanned, retained, and consolidated before the next cohort. A stopped command is resumable. Run the same command again after an interruption. Do not delete the state database, change the bank ID, or reset completed operations.

Use a second terminal to monitor without starting another importer:

```bash
while true; do
  clear
  node dist/src/importer/cli.js status
  sleep 30
done
```

Hindsight logs are available with:

```bash
scripts/stack.sh logs --tail 100 hindsight-app
```

Expected slow cases:

- one large session can take hours because its extraction sub-batches are sequential;
- consolidation allows one bank operation at a time;
- laptop sleep pauses progress;
- rate limits can reduce throughput without indicating a deadlock.

If four requests are too aggressive, stop the import and run:

```bash
scripts/configure-concurrency.sh 2
```

Then rerun the import command. Do not change concurrency while active retain operations are running.

If failures came from a temporary provider or Docker outage:

```bash
node dist/src/importer/cli.js retry-failed
scripts/import-all.sh
```

Review the errors before retrying. Parser, classification, budget, and redaction failures are not temporary failures.

## 9. Final catch-up and verification

Normal sessions can change during the historical import. Quit Pi, Codex, Claude Code, and OpenCode before the final catch-up. Keep them closed until extension installation finishes. Then run:

```bash
scripts/import-all.sh
node dist/src/importer/cli.js status
scripts/verify-full-import.sh
```

Required state before Pi activation:

```text
queued/submitted/processing/failed/cleanup_pending: 0
missing documents:                              0
unexpected documents:                           0
excluded documents present:                     0
idempotencyReady:                             true
pending or failed consolidation:                0
```

Test several known queries and at least one invented query. Known answers must include provenance. An invented query should abstain.

Create and restore-test a backup:

```bash
scripts/backup.sh
scripts/restore-test.sh \
  "$HOME/.local/state/pi-hindsight-memory/backups/hindsight-TIMESTAMP.dump"
```

## 10. Activate the Pi extension after verification

Inspect Pi packages and loose extensions before changing them:

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi list
jq '.packages' "$AGENT_DIR/settings.json"
```

Disable any existing integration that registers `memory_search` or automatically sends the same sessions to another memory service. The project cannot safely decide which unrelated integration to remove. Preserve its files and configuration for rollback.

Enable automatic consolidation:

```bash
scripts/finalize-bank.sh
```

Install this extension:

```bash
scripts/install-pi-extension.sh
```

The installer performs one last source scan and refuses to continue unless document accounting, Hindsight operations, consolidation, and bank configuration are ready. It changes no unrelated package entry and restores the previous Pi settings if installation fails.

If the final scan finds a changed session, restore bulk bank mode, process the new work, and repeat finalization:

```bash
scripts/configure-bank.sh --file deploy/compose/bank-config.json
scripts/import-all.sh
scripts/finalize-bank.sh
scripts/install-pi-extension.sh
```

Install and start continuous processing:

```bash
scripts/install-importer-service.sh --start
scripts/importer-service.sh status
scripts/install-backup-schedule.sh
```

Fully exit and restart each existing Pi process. Do not rely on `/reload` after installing or upgrading the package because a process that started with an older Pi runtime can keep stale extension state. Verify that exactly one active tool is named `memory_search` and that it comes from `pi-hindsight-memory`. The extension checks for that tool-name collision before registration.

## 11. Restart verification

Restart Docker Desktop or reboot once when convenient. Then verify:

```bash
scripts/stack.sh status
scripts/verify-deployment.sh
scripts/importer-service.sh status
node dist/src/importer/cli.js status
```

On macOS, Docker Desktop must start at login for `restart: unless-stopped` to take effect. The LaunchAgent keeps the importer alive; the importer retries Hindsight on its normal scan interval.

## Rollback

Stop continuous importing first. The installation command prints its Pi settings backup path; restore that file next:

```bash
scripts/importer-service.sh stop
scripts/restore-pi-settings.sh /path/to/settings-backup.json
```

Re-enable any integration that you disabled manually, then fully exit and restart Pi. This does not delete Hindsight, PostgreSQL, source sessions, or unrelated integration data.
