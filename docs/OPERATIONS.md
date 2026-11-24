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

Use `failureReasons` and `exhaustedFailures` in `verify-import` to identify current failed updates. If `blocked` is present, follow its action first. An admission block stops new imports without using attempts. The running, unpaused daemon still tries to poll submitted operations and checks the block again automatically. For low disk space, free space on the state and spool filesystems. For an approval block after a provider change, check the [declared routes and approval](PROVIDER-GATE.md#migrate-an-approval-for-failover). No `retry-failed` is necessary to clear a block.

An overdue submission is a warning, not an expired operation. At `importer.overdueSubmissionSeconds`, check the original operation and any child operations in Hindsight. Do not requeue a pending operation just because it is overdue. If the desktop feed is enabled, it must be fresh for complete-source readiness, even if all local scans are recent. If the feed is unavailable, the importer reports a desktop scan error, keeps its evidence, and continues local scans and polling for submitted work.

The daemon retries a failed cycle after `importer.retryDelayMs` (30 seconds by default), rather than waiting for the full scan interval. A successful queue recovery clears its cycle error immediately. `importer.maxAttempts` defaults to three; exhausted failures need review before an explicit retry or a higher limit. See [configuration](CONFIGURATION.md).

## Linux importer rollout

On the importer host, run this command from a Git checkout that contains the target revision:

```bash
scripts/deploy-importer.sh REVISION
```

The rollout uses `/usr/local/bin/node` by default. It exports the commit, installs locked dependencies, builds, and checks the configuration before it stops the user unit. It does not change the checkout or reuse an unmanaged directory with the same revision name. Snapshots are under `${XDG_DATA_HOME:-$HOME/.local/share}/pi-hindsight-memory-cutover`.

Use the same configuration and settings as the running service. Set `PI_HINDSIGHT_CONFIG` if the service uses a non-default config and `PI_HINDSIGHT_SSH_HOST` if PostgreSQL is remote. Keep other Hindsight writers idle during the rollout. The script stops the unit before it takes a coordinated backup. If there is unresolved remote work or the backup fails, the script does not switch runtimes.

The rollout replaces only the `90-runtime.conf` user-unit drop-in. The new importer has 600 seconds by default to report a fresh idle heartbeat and pass document accounting. Set `PI_HINDSIGHT_ROLLOUT_TIMEOUT_SECONDS` to a positive whole number of seconds (up to nine digits) to change this limit. The rollout checks again while queued or submitted work finishes. Settling sessions alone do not block deployment. A failed update, a missing or unexpected document, a hash mismatch, or a change to the importer's main process ends the rollout without another check.

This rollout does not change the Hindsight image. For an image change, use the [Hindsight upgrade gate](DEPLOYMENT.md#hindsight-upgrade-gate).

If the rollout fails, it restores the previous runtime configuration and does not restore SQLite or PostgreSQL. If a SQLite schema changed or cannot be read, it leaves the importer stopped. Check compatibility before restarting it. Check the journal after a rollback.

The inventory lists local unit, Pi settings, and user script references that the rollout can find. It does not delete snapshots. Check other hosts and external scripts before removing a snapshot manually. On macOS, installation still uses the LaunchAgent; the rollout script is Linux-only.

## Pause and resume

```bash
node dist/src/importer/cli.js pause
node dist/src/importer/cli.js resume
```

Pause prevents daemon scans and submissions. It does not cancel active Hindsight operations. Wait for active operations before maintenance or deletion.

## Retry failures

Find and correct the cause before resetting attempts on failed updates. Stop the importer service before you reset them; the command needs the writer lock. Start the service again so the daemon can process the queue:

```bash
scripts/importer-service.sh stop
node dist/src/importer/cli.js retry-failed
scripts/importer-service.sh start
```

`daemon --no-scan` processes only existing queued work and does not discover source sessions, including in continuous mode. Use the normal daemon for scheduled source scanning.

If you are running a one-off import instead of a service, wait for the previous command to stop, reset the failures, then resume that import. To process just the existing queue while the service is stopped, use `process-queued`. This supports continuous-mode auto-consolidation. Known terminal failures can receive a new operation ID. `retry-failed` does not reset unresolved submissions.

Use `retry-unresolved` only after you review **all** held submissions and confirm it is safe to send each retain again. Check the original operation and any conflicting receipt ID in Hindsight. Check the remote document and its expected hash. If a prior write can still run or its outcome makes a repeat unsafe, leave the holds in place.

```bash
scripts/importer-service.sh stop
node dist/src/importer/cli.js retry-unresolved
scripts/importer-service.sh start
```

The command prints the number of requeued generations. It does not requeue generations that are already pending exclusion cleanup. It saves each verified payload under a new operation ID before replacing the queue entry. An invalid or obsolete payload stops the command without clearing the holds. When there is no saved payload, the importer must reproduce the same hash from the source before it can submit. For a historical repair, resume with its reviewed `repair --plan` command before you start the normal importer.

## Pending spool cleanup

Stop the importer before you inspect or clean the pending spool. Both commands need the writer lock.

```bash
scripts/importer-service.sh stop
node dist/src/importer/cli.js spool-cleanup
node dist/src/importer/cli.js spool-cleanup --apply
scripts/importer-service.sh start
```

Run without `--apply` to preview the cleanup. The command reports eligible, kept, and removed file counts and bytes. It removes only files with a matching terminal operation and a superseded, excluded, or completed generation. It keeps repair payloads, unresolved submissions, and files without matching state, including untracked `.tmp` files. It does not contact Hindsight.

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

## Reviewed exclusion cleanup

Stop the importer and make a backup before you apply a cleanup plan. Do not let other clients write to the bank during review or cleanup. Hindsight does not provide a conditional delete that checks the document hash on the server.

```bash
pi-hindsight-memory plan-cleanup --output cleanup.json
# Review the file before you continue.
pi-hindsight-memory cleanup-subagents --apply --plan cleanup.json
```

The plan does not change source files or importer state. Review the counts, `jobs`, and `blocked` entries. The plan identifies the endpoint and bank. Each job shows the source owner, generations, operation states, and whether the remote document exists. If it exists, the job includes its hash. The plan can exclude definite subagents and sessions with configured exclusions. `--include-ambiguous` adds eligible ambiguous sessions, but never frozen `ambiguous_preserved` sessions. A missing source is not a cleanup target.

Apply takes the importer writer lock and checks the plan again. Do not edit the plan to clear an error. If a target changed or a delete failed, make and review a new plan. If an operation is unresolved, let it end and resolve any unknown state before you make a new plan. If a cleanup job from an older version conflicts with a new plan, investigate the old job before you continue. Run `verify-import` after cleanup and before you restart the importer.

## Hindsight outage

Operations and queue state are durable. After Hindsight returns:

```bash
node dist/src/importer/cli.js process-queued --max-ms 86400000
```

Stop the importer service before you use the manual command. Otherwise, the daemon performs recovery. If the importer knows a retain was not sent, it can try again with the same operation ID. For a retain that may have reached Hindsight, the importer polls the original operation ID. If Hindsight no longer has the operation, the importer accepts a matching remote document hash as proof of completion, except when the prior document already had that hash. A matching hash alone cannot prove that a policy-only rewrite ran.

An invalid receipt, unknown operation status, or missing operation without proof of completion causes an `unresolved-submission` hold. The importer keeps the operation ID and payload and does not send a new retain for that document. To investigate, record the operation ID and compare Hindsight's operation and document records with the generation's expected hash. For a conflicting receipt, also check server records for the ID returned by Hindsight. Keep the document on hold until an operator reviews whether the previous write can still run. After a successful review, use `retry-unresolved` as described above. Do not edit state rows or reset retry timestamps.

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
