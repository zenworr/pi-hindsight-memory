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
PI_HINDSIGHT_BIND_ADDRESS       default: 127.0.0.1
PI_HINDSIGHT_API_PORT           default: 8888
PI_HINDSIGHT_UI_PORT            default: 9999
PI_HINDSIGHT_WORKER_ID          default: pi-hindsight-worker
PI_HINDSIGHT_CONCURRENCY        default: 4
PI_HINDSIGHT_COMPOSE_PROJECT    default: pi-hindsight-memory
HINDSIGHT_TAG                   first-run default: ghcr.io/vectorize-io/hindsight:0.10.3
POSTGRES_TAG                    default: docker.io/pgvector/pgvector:pg18
```

The script pulls native images for the host architecture. If `.env` already contains image pins, it keeps them unless you explicitly set `HINDSIGHT_TAG` or `POSTGRES_TAG` for the corresponding image. Both overrides accept either a tag or an immutable image reference. The script records the selected pins in `.env` and `versions.env`. It records the Hindsight release from the pinned image's OCI version label or release tag, or `unknown` if neither supplies a release. Set `VERIFY_HINDSIGHT_SIGNATURE=1` to verify the resolved Hindsight pin with Cosign. PostgreSQL is digest-pinned but this project does not verify its signature.

Generated secrets use mode `0600`. PostgreSQL reads a minimal `postgres.env` containing only its user, password, and database name; it never receives Hindsight API or provider credentials. The separate `hindsight.env` contains the database URL and application settings. The generated runtime configuration uses no extraction LLM, local embeddings, local reranking, stored document text, external PostgreSQL, disabled automatic consolidation, and loopback-only API/UI ports. Set `PI_HINDSIGHT_BIND_ADDRESS` to a trusted LAN address only when a reverse proxy or private network must reach the service.

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

## Hindsight upgrade gate

Use this gate for any Hindsight image change, including during Proxmox VE maintenance. Treat an OS or PostgreSQL update as a separate change. Do not let it move the Hindsight pin.

1. Before the change, record the running image reference and image ID on the service host. Query the API's `/version`. If telemetry is enabled, record the `service.version` on fresh `hindsight-api` data in your collector backend. Compare the configured pin with the running reference. A local tag lookup is **not** evidence of what the container runs; the tag may point to a different digest.

   ```bash
   docker inspect --format '{{.Config.Image}} {{.Image}}' hindsight-app
   curl -fsS "${API_URL%/}/version"
   ```

   `.Config.Image` is the reference used to create the container; `.Image` is its image ID, not a registry digest. If the running reference is not digest-pinned, recover a verified pin before proceeding. Do not substitute a digest from a mutable tag.
2. Run `npm run validate` on the importer revision, the [disposable-bank contract smoke](TESTING.md#live-contract-tests) on the current server, and the [telemetry SDK admission and privacy check](TELEMETRY.md#runtime-checks) with the current image's Python runtime. Review the server's migration and recovery instructions; switching the pin back alone may not reverse a database migration.
3. Test the candidate digest in an isolated deployment with a separate database and configuration. Repeat the contract and SDK checks with the candidate and verify that new telemetry uses the candidate release and contains no private fields. Do not proceed if a check fails.
4. For the authorized cutover, stop the importer and let active operations finish. Take a coordinated backup of PostgreSQL and importer state. Save the current pin and private Compose and application settings. Set `HINDSIGHT_TAG` to the tested reference when running `scripts/prepare-deployment.sh`. Keep private Compose settings such as the telemetry endpoint when replacing the generated `.env`. Use the same Compose files and local overrides as before. Recreate only `hindsight-app`.
5. Record the running reference, API version, and fresh `service.version` again. Repeat the checks from step 2. Run `verify-import` on the importer host before starting the importer. If a check fails, keep the importer stopped and use the reviewed recovery procedure.

## Startup

On macOS, Docker Desktop owns container startup. Enable its login startup option. Compose uses `restart: unless-stopped`.

On Linux, install the dedicated user service:

```bash
scripts/install-stack-service.sh
```

This service manages only this Compose project. It does not start unrelated containers.

The importer has a separate systemd or launchd installer. Do not start it until historical import verification is complete.
