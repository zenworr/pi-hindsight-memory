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

Logs contain source IDs, counts, hashes, and bounded errors. They must not contain transcript text or original secret values. Normal scans defer a changed fingerprint until scanner observations show it stable for `sessionSettleSeconds`; `active` in a scan summary is a deferred count, not an error. Use `scan --force` only for a controlled final catch-up after writers are closed.

## Pause and resume

```bash
node dist/src/importer/cli.js pause
node dist/src/importer/cli.js resume
```

Pause prevents daemon scans and submissions. It does not cancel active Hindsight operations. Wait for active operations before maintenance or deletion.

## Retry failures

Inspect the error first. Retry only failures caused by a temporary provider, network, database, or container outage:

```bash
node dist/src/importer/cli.js retry-failed
node dist/src/importer/cli.js process-queued --max-ms 86400000
```

Do not edit state rows by hand.

## Backups

```bash
scripts/backup.sh
scripts/restore-test.sh \
  ~/.local/state/pi-hindsight-memory/backups/hindsight-TIMESTAMP.dump
scripts/install-backup-schedule.sh
```

Set `PI_HINDSIGHT_BACKUP_DIR` to use another persistent location. PostgreSQL uses `pg_dump`; importer state uses SQLite `.backup`. The script retains four backup pairs and checksum files. For a split-host deployment, set `PI_HINDSIGHT_SSH_HOST` as described in [REMOTE-DEPLOYMENT.md](REMOTE-DEPLOYMENT.md).

## Source missing

When a source disappears, Hindsight evidence remains and the session becomes `source_missing`. Source cleanup is not interpreted as a request to forget memory.

## Hindsight outage

Operations and queue state are durable. After Hindsight returns:

```bash
node dist/src/importer/cli.js process-queued --max-ms 86400000
```

The importer polls a known operation before resubmission and reuses caller-owned operation IDs.

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
