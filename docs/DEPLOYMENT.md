# Deployment

Use [SETUP-GUIDE.md](SETUP-GUIDE.md) for the complete operator workflow.

## Supported container engines

The scripts auto-detect Docker first and Podman second. Override detection with:

```bash
PI_HINDSIGHT_CONTAINER_ENGINE=docker scripts/setup.sh
PI_HINDSIGHT_CONTAINER_ENGINE=podman scripts/setup.sh
```

The Compose definition is `deploy/compose/compose.yaml`. Local `.env` and `versions.env` files are generated and ignored by Git. Optional host-specific Compose changes belong in the ignored `deploy/compose/compose.local.yaml` file.

## Local paths

Configuration follows XDG environment variables when they are set:

```text
${XDG_CONFIG_HOME:-~/.config}/pi-hindsight-memory
${XDG_STATE_HOME:-~/.local/state}/pi-hindsight-memory
```

Backups default to the state directory. Set `PI_HINDSIGHT_BACKUP_DIR` to use another persistent location.

## Preparation settings

Set these variables before the first `scripts/prepare-deployment.sh` call when defaults are not suitable:

```text
PI_HINDSIGHT_BANK_ID            default: coding-history
PI_HINDSIGHT_API_PORT           default: 8888
PI_HINDSIGHT_UI_PORT            default: 9999
PI_HINDSIGHT_WORKER_ID          default: pi-hindsight-worker
PI_HINDSIGHT_CONCURRENCY        default: 4
PI_HINDSIGHT_COMPOSE_PROJECT    default: pi-hindsight-memory
HINDSIGHT_TAG                   default: ghcr.io/vectorize-io/hindsight:0.9.2
POSTGRES_TAG                    default: docker.io/pgvector/pgvector:pg18
```

The script pulls the native image for the host architecture and records immutable image digests. Set `VERIFY_HINDSIGHT_SIGNATURE=1` to require Hindsight's documented keyless Cosign signature. PostgreSQL is digest-pinned but its signature is not asserted by this project.

Generated secrets use mode `0600`. The generated runtime configuration uses no extraction LLM, local embeddings, local reranking, stored document text, external PostgreSQL, disabled automatic consolidation, and loopback-only API/UI ports.

## Stack commands

```bash
scripts/stack.sh up
scripts/stack.sh stop
scripts/stack.sh status
scripts/stack.sh logs --tail 100 hindsight-app
scripts/verify-deployment.sh
```

PostgreSQL has no host port. The API uses bearer authentication even though it is loopback-bound. PostgreSQL 18 stores its versioned data directory below `/var/lib/postgresql`, so the Compose stack mounts the named volume at that parent path and does not create an anonymous parent volume.

For an always-on service host with a workstation-side importer, use the [remote deployment guide](REMOTE-DEPLOYMENT.md).

## Startup

On macOS, Docker Desktop owns container startup. Enable its login startup option. Compose uses `restart: unless-stopped`.

On Linux, install the dedicated user service:

```bash
scripts/install-stack-service.sh
```

This service manages only this Compose project. It does not start unrelated containers.

The importer has a separate systemd or launchd installer. Do not start it until historical import verification is complete.
