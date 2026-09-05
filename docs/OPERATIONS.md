# Operations

## Status

```bash
node dist/src/importer/cli.js status
node dist/src/importer/cli.js doctor
scripts/stack.sh status
scripts/stack.sh logs --tail 100 hindsight-app
scripts/importer-service.sh status
```

Importer logs are under the local state directory on macOS. On Linux, use:

```bash
journalctl --user -u pi-hindsight-importer.service -n 100
```

Logs contain source IDs, counts, hashes, and bounded errors. They must not contain transcript text or original secret values. Source parsing errors are stored separately and remain visible until a successful scan clears them. Status also distinguishes a paused or stopped importer from an idle queue. Normal scans defer a changed fingerprint until scanner observations show it stable for `sessionSettleSeconds`; `active` in a scan summary is a deferred count, not an error. Use `scan --force` only for a controlled final catch-up after writers are closed.

## Pause and resume

```bash
node dist/src/importer/cli.js pause
node dist/src/importer/cli.js resume
```

Pause prevents daemon scans and submissions. It does not cancel active Hindsight operations. Wait for active operations before maintenance or deletion.

## Retry failures

Inspect the error first. Retry only failures caused by a temporary provider, network, database, or container outage:

Stop the importer service before these commands; they need its exclusive lock:

```bash
scripts/importer-service.sh stop
node dist/src/importer/cli.js retry-failed
node dist/src/importer/cli.js process-queued --max-ms 86400000
scripts/importer-service.sh start
```

`process-queued` supports continuous-mode auto-consolidation. Unknown remote outcomes stay submitted and are polled before any source reread. Known terminal failures receive a fresh retry identity. Do not edit state rows by hand.

## Backups

```bash
scripts/backup.sh
scripts/restore-test.sh \
  ~/.local/state/pi-hindsight-memory/backups/hindsight-TIMESTAMP.dump
scripts/install-backup-schedule.sh
```

Set `PI_HINDSIGHT_BACKUP_DIR` to use another persistent location. PostgreSQL uses `pg_dump`; importer state uses SQLite `.backup`. The script retains four backup pairs and checksum files. For a split-host deployment, set `PI_HINDSIGHT_SSH_HOST` as described in [REMOTE-DEPLOYMENT.md](REMOTE-DEPLOYMENT.md).

The two database snapshots are not atomic. Keep the importer stopped and remote work idle when you need a consistent pair. The existing restore helper checks counts and API availability, not generation hashes or semantic correctness. After a real restore, run `verify-ready` and check a known result with its original source before enabling normal operation.

## Source missing

When a source disappears, Hindsight evidence remains and the session becomes `source_missing`. Source cleanup is not interpreted as a request to forget memory.

## Hindsight outage

Operations and queue state are durable. After Hindsight returns:

```bash
node dist/src/importer/cli.js process-queued --max-ms 86400000
```

The importer polls a known operation before resubmission and reuses caller-owned operation IDs with the original immutable payload. Stop the importer service first if you use the manual command; otherwise the running daemon performs recovery itself.

## Retrieval quality and policy repairs

An empty queue does not prove that a memory is correct. Check original quotations, source scope, corrections, and dates. See [Memory retrieval](MEMORY-RETRIEVAL.md).

For changes to parser, redaction, or extraction policy, follow [Historical repair](HISTORICAL-REPAIR.md). Existing ambiguous snapshots remain frozen. Do not use a bank deletion or global observation reset as a repair shortcut.

## Provider or concurrency changes

Pause the importer and wait for active operations. Change the provider with `configure-provider.sh` or coordinated limits with `configure-concurrency.sh`. Run provider, retain, recall, and consolidation smoke tests before resuming.

## Upgrades

Do not update Hindsight automatically:

1. review release and migration notes;
2. create and restore-test a backup;
3. pull and pin the new native-platform image digest;
4. run project and contract tests;
5. compare recall quality, latency, and storage;
6. update the live stack only after review.

Do not combine an embedding-model change with a Hindsight version change.
