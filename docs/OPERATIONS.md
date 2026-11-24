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

`verify-import` reports `failedHindsightOperations` for diagnostics. This count includes retained terminal history and does not block readiness by itself. Current failed generations, document mismatches, active operations, and failed or pending consolidation still block readiness. Retained failure records are not deleted during recovery.

The daemon retries a failed cycle after `importer.retryDelayMs` (30 seconds by default), rather than waiting for the full scan interval. A successful queue recovery clears its cycle error immediately. `importer.maxAttempts` defaults to three; exhausted failures need review before an explicit retry or a higher limit. See [configuration](CONFIGURATION.md).

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

`daemon --no-scan` processes only existing queued work and does not discover source sessions, including in continuous mode. Use the normal daemon for scheduled source scanning.

`process-queued` supports continuous-mode auto-consolidation. Unknown remote outcomes stay submitted and are polled before any source reread. Known terminal failures receive a fresh retry identity. Do not edit state rows by hand.

## Backups

Stop the importer before a coordinated capture. Keep other Hindsight writers (including manual UI writes) idle until capture ends. Use a known query and the exact document ID that supports the expected answer.

```bash
scripts/importer-service.sh stop
scripts/backup.sh --coordinated
scripts/importer-service.sh start
scripts/restore-test.sh /path/to/backup-TIMESTAMP-ID/manifest.json \
  'known query' 'agent-session:pi:KNOWN_SESSION_ID'
```

Set `PI_HINDSIGHT_BACKUP_DIR` to use another persistent location. To select a non-default app config, set `PI_HINDSIGHT_CONFIG`. The backup resolves source paths from the merged app config. Each set contains a PostgreSQL dump, SQLite online backups of importer state and local evidence, and a copy of the reviewed facts file if present. The versioned manifest records file checksums, source paths, Git revision, document counts, and the consistency label. The script publishes the set as one directory after verification. It does not delete older backups. Treat the directory and manifest as sensitive.

Coordinated mode holds the importer writer lock. It refuses unresolved local operations and checks for idle remote operations and matching document IDs and hashes before and after the dump. If these checks fail, reconcile the outstanding work before you retry. This mode does not lock other Hindsight clients. For a split-host deployment, see [REMOTE-DEPLOYMENT.md](REMOTE-DEPLOYMENT.md).

`scripts/install-backup-schedule.sh` installs weekly **uncoordinated** captures. These do not stop the importer or assert that the two databases represent the same generation. An SSH backup without a mode flag is also uncoordinated, to support read-only mirrors. The manifest gives no verified Hindsight document count for these sets.

The restore test uses a temporary database, application, and loopback port. It checks file checksums, SQLite integrity, the full document ID and acknowledged-hash mapping, and whether the known query returns the specified document directly or through linked source facts. Strict verification rejects uncoordinated captures. Use `--allow-uncoordinated` to test a new uncoordinated set without accepting it as coordinated. Legacy dumps lack a manifest and evidence snapshot and cannot pass this test. After a real restore, run `verify-ready` and check the expected answer against its original source before enabling normal operation.

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

## Importer writer lock

Stop the old importer service and let all old writer commands finish before you switch between the PID-file and SQLite-lock versions. The two versions do not share a lock.

The importer takes an exclusive lock on `<resolved-stateDatabase>.writer-lock`, not on the state database. Read-only status, retrieval, and verification can still read the state database. Keep the sidecar on a local filesystem with SQLite locking support. Do not delete, move, or replace the sidecar, and do not use hard links for the state database. A sidecar left on disk does not mean a writer is running; the operating system releases the lock when the process exits.

Maintenance code can import `withWriterLock(databasePath, callback)` from `dist/src/importer/lock.js`. It does not open or migrate the state database. Await all work inside the callback, including any child process. If you handle termination signals, stop and wait for that work before you let the callback return or the lock owner exit. For a lock-busy error, stop `pi-hindsight-importer` or wait for the other writer to finish. Pausing the daemon does not release the lock.

## Upgrades

Do not update Hindsight automatically, including during Proxmox VE maintenance. Use the [Hindsight upgrade gate](DEPLOYMENT.md#hindsight-upgrade-gate). Restore-test the backup and compare recall quality, latency, and storage before cutover. Do not combine an embedding-model change with a Hindsight version change.
