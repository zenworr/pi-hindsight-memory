# OpenTelemetry

Telemetry is optional. The importer and Pi retrieval package export traces, metrics, and logs with OTLP HTTP/protobuf. The default configuration sends no telemetry.

```text
Importer / Pi retrieval ─── OTLP HTTP ─── Collector
Hindsight API + worker ──── OTLP HTTP ─── Collector
                                           │
                                    Traces / metrics / logs
```

## Importer and Pi retrieval

Create `telemetry.env` in the configuration directory (normally `~/.config/pi-hindsight-memory`). Use a collector that can receive all three signals:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Use `PI_HINDSIGHT_TELEMETRY_FILE` to select another file. Process environment variables take precedence. A base endpoint gets `/v1/traces`, `/v1/metrics`, and `/v1/logs` appended. You can instead set all three `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` variables to full URLs. URL credentials, queries, and fragments are not supported.

The service names are `hindsight-importer` and `hindsight-retrieval`. `OTEL_SERVICE_NAME` can override the name. Resources include the package release version and `deployment.environment.name`. Set `OTEL_DEPLOYMENT_ENVIRONMENT` to `production` (default), `development`, or `test`. The file is read at startup. Restart the importer and fully exit and restart Pi to load the package. Resources start on `session_start`, stop on `session_shutdown`, and restart after reload. The package uses private providers and private asynchronous context. It does not replace another extension's global OpenTelemetry provider.

Set `OTEL_SDK_DISABLED=true` to stop telemetry. Remove the endpoint to return to the default disabled mode.

### Coverage

- Import cycles, preflight, source discovery, changed-source normalization, evidence indexing, immutable payload persistence, generation processing, verification, and retain submission.
- Logical HTTP requests and individual attempts, with status codes and retry counts. W3C trace context connects these spans to the server.
- Memory search, Hindsight recall, result counts, no-match results, and local fallback.
- Structured application logs, correlated with the active span.
- Process RSS, CPU time, and uptime.

The test commands clear inherited OTEL settings and ignore the operator's telemetry file. Telemetry tests use in-memory exporters or a local test receiver, not the production collector.

An independent sample inside the daemon runs every 60 seconds, including while the importer is paused or idle. It uses read-only local state and bounded remote API calls. It reports:

| Metric | Meaning |
| --- | --- |
| `hindsight.importer.running`, `.paused`, `.cycle_error` | Current importer state, as 0 or 1 |
| `hindsight.importer.generations` | Queue state, labelled by `state` |
| `hindsight.importer.coverage` | Scan errors, settling, unprocessed work, stale sources, and uncertain operations |
| `hindsight.importer.heartbeat_age` | Age in seconds; -1 means unavailable |
| `hindsight.importer.document_accounting_ready` | Result of the most recent cycle verification |
| `hindsight.importer.document_mismatches` | Content-hash mismatch count from that verification |
| `hindsight.feed.age`, `.stale` | Desktop-feed age and stale flag, only when the feed is enabled |
| `hindsight.server.healthy`, `.database_connected` | API and database health, as 0 or 1 |
| `hindsight.server.documents`, `.operations`, `.consolidation` | Remote counts, with state labels where needed |
| `hindsight.setup.issues`, `.monitor_error` | Current issue count and sampling failure flag |
| `hindsight.importer.disk.available` | Free bytes on the state filesystem |
| `hindsight.stage.duration`, `.operations` | Stage duration histogram and outcome counter |
| `hindsight.import.generations` | Generation results by source and outcome |
| `hindsight.import.queue_wait` | Seconds from queue admission to the first worker attempt; excludes settling and execution |
| `hindsight.telemetry.heartbeat` | Current Unix time, sampled by the metric reader even while idle |
| `hindsight.telemetry.export_failures` | Cumulative failed export batches, labelled by signal |
| `hindsight.telemetry.last_success_age` | Seconds since the last successful export, labelled by signal; omitted until the first success |
| `hindsight.http.responses`, `.retries` | HTTP responses and retries |
| `hindsight.scan.sessions` | Scan results by outcome |
| `hindsight.memory.searches`, `.results` | Search outcomes and result counts |

Retained historical Hindsight failure records do not count as current health failures. A stale desktop feed is reported as stale; it does not prove that history was lost. A stopped importer sends no samples. Missing data is not a healthy state. Use a no-data alert for importer loss. Do not fill gaps with zero.

## Hindsight server

Hindsight 0.9.2 has native operation and LLM spans, FastAPI trace-context propagation, and metrics for LLM calls, HTTP requests, operations, process use, and the database pool. Its normal tracing also includes prompts and completions. Do not enable that exporter without the content filter.

The optional [Compose override](../deploy/telemetry/compose.yaml) mounts [sitecustomize.py](../deploy/telemetry/sitecustomize.py) into the pinned Python runtime. It filters span names, attributes, events, links, status descriptions, and metric labels before SDK storage. The export filter remains as a second check. It adds an OTLP metric reader alongside the existing Prometheus reader and exports content-safe Python logs. Both metric readers receive the filtered labels; numeric measurements are preserved. It does not change the Hindsight image, database, provider, bank, or evidence policy.

Add the OTLP base endpoint to the private Compose environment, then include the override after your normal files. Keep any provider-specific local override:

```bash
cd deploy/compose
# Set OTEL_EXPORTER_OTLP_ENDPOINT in the private .env first.
docker compose --env-file .env -f compose.yaml -f compose.local.yaml \
  -f ../telemetry/compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.local.yaml \
  -f ../telemetry/compose.yaml up -d --no-deps --force-recreate hindsight-app
```

Omit `compose.local.yaml` if it does not exist. Stop the importer and let remote operations finish before the app restart. Do not recreate PostgreSQL. Check API health before resuming the importer.

This adapter is tested against the pinned Hindsight 0.9.2 Python SDK. Test it again before an image upgrade. If initialization fails, it disables native trace export to prevent content leakage. Remove the telemetry override and recreate only the app to roll back.

## Privacy and failure behavior

Stages report `ok`, `error`, `cancelled`, or `incomplete`. Handled failures and deferred work retain their real outcome in both spans and counters.

No session text, search query, recall result, prompt, completion, source path, session ID, API token, authorization header, error message, or stack trace is exported. Routes use ID placeholders. Server span events and links are removed. Server logs use known operational event categories instead of raw messages. Original diagnostic logs remain local. Log labels and metric labels use bounded operational values, not session or document identifiers.

The SDK batches exports with bounded queues and three-second export budgets. Export failures do not fail importer work or retrieval. They can cause telemetry loss. Shutdown flushes pending telemetry without changing importer recovery semantics. All three signals must be verified in the backend; HTTP 200 alone is not sufficient.

## SigNoz dashboard

Manage Hindsight Health with the pinned `SigNoz/signoz` Terraform provider `0.1.5` and its typed V2 resource. SigNoz must be version 0.135 or later. The [dashboard catalog](../deploy/telemetry/hindsight-health.json) is the single source for panel definitions and queries; [Terraform](../deploy/telemetry/terraform/main.tf) maps it to the provider schema. Do not maintain a separate UI-edited copy. The dashboard uses the v6 schema. It shows importer and server health, queue and coverage, feed freshness, consolidation, latency, retries, process use, and database pool use. The panels select Hindsight service names, so other instrumented projects remain separate. Health values use green for the expected state and red for other values. Health number panels use the last five minutes. Duration panels calculate average latency from histogram sum and count rates. Work and token panels can have no data while idle or before the first operation; do not interpret these gaps as a fault or as proof of health.

### Provisioning and verification

Run dashboard management from an authorized management host, not from application workers. Keep management access separate from OTLP ingestion. The wrapper reads `SIGNOZ_ACCESS_TOKEN` or the protected `~/.config/signoz/api-header` file without printing its value. It disables Terraform debug logging. It does not change SigNoz authentication or create credentials.

```bash
scripts/telemetry-dashboard.sh validate
# Import an existing dashboard before the first plan on this host.
scripts/telemetry-dashboard.sh import signoz_dashboard.hindsight <dashboard-id>
scripts/telemetry-dashboard.sh plan
# Review the plan before applying it.
scripts/telemetry-dashboard.sh apply
scripts/telemetry-dashboard.sh plan -detailed-exitcode
```

The last command must report no changes. `prevent_destroy` protects the dashboard from replacement. The wrapper keeps per-project state under `$XDG_STATE_HOME/pi-hindsight-memory/signoz` (default `~/.local/state/pi-hindsight-memory/signoz`) and provider data under `$XDG_CACHE_HOME/pi-hindsight-memory/signoz-terraform`. These directories have mode 0700. State and backup files have mode 0600. Retain the protected state backup when moving management to another host. Never reuse another project's state. Commit the dependency lock file, not state, plans, credentials, or caches.

Terraform includes two optional missing-data rules, for the always-on production importer and Hindsight API. SigNoz requires a notification channel before it can store these rules. To enable them, set `TF_VAR_alert_channels='["existing-channel-name"]'` with existing SigNoz channel names when running the management commands. With the default empty list, the rules are disabled and dashboard management still works.

The rules evaluate each minute: a two-minute heartbeat window must be empty for three minutes before alerting, about five to six minutes after the last sample. Pi retrieval is not continuously running and has no such rule. These rules do not change the desktop-feed age limit. Export-health panels work without notification channels.

The mock-provider test verifies schema, identity, query references, service filters, layout, and missing-data rules without credentials. This is not a live-data check. After apply, run every stored query with the authenticated V5 query API and inspect errors, warnings, timestamps, and numeric samples. Verify stored traces, metrics, and logs separately. A quiet retry or token panel is not a fault. Do not restart an application for a dashboard-only change.

### Runtime checks

Run `scripts/checks/telemetry-sdk.py` with the pinned Python SDK `1.44.0` and OTLP HTTP exporter `1.44.0`, or inside the pinned Hindsight image with its argument set to the shim path. CI uses an isolated virtual environment. This checks SDK buffers before export, parent/child context, numeric metrics, and private-field removal without provider calls.

After `npm run build`, run `node --import ./scripts/checks/test-telemetry.mjs scripts/checks/telemetry-overhead.mjs disabled` and repeat with `enabled`. The temporary 100-session workflow uses mocked remote operations and discard exporters. Python SDK hot-path checks use `scripts/checks/telemetry-overhead.py disabled` and `enabled` in the isolated SDK environment. Compare repeated runs. Measurements exclude initialization and shutdown; they do not represent remote-provider latency or collector network cost. Do not make a timing threshold a flaky CI gate.

For details, open Traces or Logs and filter `service.name` to `hindsight-importer`, `hindsight-retrieval`, or `hindsight-api`. HTTP calls share trace IDs across the client and server. Asynchronous server tasks can have separate traces; do not assume that an HTTP request span covers the whole retain operation.
