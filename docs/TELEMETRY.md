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

The service names are `hindsight-importer` and `hindsight-retrieval`. `OTEL_SERVICE_NAME` can override the name. The file is read at startup. Restart the importer and fully exit and restart Pi to load the package. Resources start on `session_start`, stop on `session_shutdown`, and restart after reload. The package uses private providers and private asynchronous context. It does not replace another extension's global OpenTelemetry provider.

Set `OTEL_SDK_DISABLED=true` to stop telemetry. Remove the endpoint to return to the default disabled mode.

### Coverage

- Import cycles, preflight, source discovery, changed-source normalization, evidence indexing, immutable payload persistence, generation processing, verification, and retain submission.
- Logical HTTP requests and individual attempts, with status codes and retry counts. W3C trace context connects these spans to the server.
- Memory search, Hindsight recall, result counts, no-match results, and local fallback.
- Structured application logs, correlated with the active span.
- Process RSS, CPU time, and uptime.

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
| `hindsight.http.responses`, `.retries` | HTTP responses and retries |
| `hindsight.scan.sessions` | Scan results by outcome |
| `hindsight.memory.searches`, `.results` | Search outcomes and result counts |

Retained historical Hindsight failure records do not count as current health failures. A stale desktop feed is reported as stale; it does not prove that history was lost. A stopped importer sends no samples. Missing data is not a healthy state. Use a no-data alert for importer loss. Do not fill gaps with zero.

## Hindsight server

Hindsight 0.9.2 has native operation and LLM spans, FastAPI trace-context propagation, and metrics for LLM calls, HTTP requests, operations, process use, and the database pool. Its normal tracing also includes prompts and completions. Do not enable that exporter without the content filter.

The optional [Compose override](../deploy/telemetry/compose.yaml) mounts [sitecustomize.py](../deploy/telemetry/sitecustomize.py) into the pinned Python runtime. It filters native traces before export, adds an OTLP metric reader alongside the existing Prometheus reader, and exports content-safe Python logs. It does not change the Hindsight image, database, provider, bank, or evidence policy.

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

No session text, search query, recall result, prompt, completion, source path, session ID, API token, authorization header, error message, or stack trace is exported. Routes use ID placeholders. Server span events and links are removed. Server logs use known operational event categories instead of raw messages. Original diagnostic logs remain local. Log labels and metric labels use bounded operational values, not session or document identifiers.

The SDK batches exports with bounded queues and three-second export budgets. Export failures do not fail importer work or retrieval. They can cause telemetry loss. Shutdown flushes pending telemetry without changing importer recovery semantics. All three signals must be verified in the backend; HTTP 200 alone is not sufficient.

## SigNoz dashboard

Import [Hindsight Health](../deploy/telemetry/hindsight-health.json) into SigNoz 0.135 or later. The dashboard uses the v6 schema. It shows importer and server health, queue and coverage, feed freshness, consolidation, latency, retries, process use, and database pool use. The panels select Hindsight service names, so other instrumented projects remain separate.

For details, open Traces or Logs and filter `service.name` to `hindsight-importer`, `hindsight-retrieval`, or `hindsight-api`. HTTP calls share trace IDs across the client and server. Asynchronous server tasks can have separate traces; do not assume that an HTTP request span covers the whole retain operation.
