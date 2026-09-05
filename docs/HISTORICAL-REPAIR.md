# Historical evidence repair

Use this workflow when an evidence-policy change affects documents that were already imported. Do not delete the bank or reset all observations as an upgrade shortcut.

A repair preserves stable document IDs. Each changed policy generation receives a fresh operation ID. The worker stores an immutable redacted payload before replacement, then checkpoints preparation, deletion, submission, and completion. Interrupted work resumes from that payload rather than rereading a changed source file.

Only reviewed primary-session targets are repaired. Frozen ambiguous snapshots are not included. A configured exclusion remains stronger than ordinary classification and must complete its separate cleanup workflow.

## Before repair

1. Keep the checkout at its permanent path.
2. Stop new submissions and resolve already active operations before changing policy.
3. Confirm provider, privacy, resource, and cost approval.
4. Run the tests and a small isolated quality pilot with the new policy.
5. Keep a usable recovery point according to your own backup policy.

```bash
node dist/src/importer/cli.js pause
scripts/importer-service.sh stop
```

If work is already submitted, the worker can reconcile it without reading a changed or missing source. Stop on unresolved operation or source errors. Do not reset operation rows by hand.

## Build and review a plan

Build the local index and desired canonical state first. This step does not contact an extraction model:

```bash
node dist/src/importer/cli.js index-evidence --force
node dist/src/importer/cli.js plan-repair --output repair-plan.local.json
```

Review:

- every target document and source;
- the previous acknowledged hash and new canonical hash;
- canonical size and estimated resource use;
- protected, missing, excluded, or empty sources that are not repair targets.

The plan hash binds the targets to the API, bank, source configuration, exclusion labels, declared provider, and evidence policy. A changed plan or configuration is rejected.

Keep private plans outside Git. Native histories remain authoritative and are not changed by repair.

## Apply the policy and repair

Apply the reviewed bank template. It disables automatic consolidation for this maintenance phase:

```bash
scripts/configure-bank.sh
node dist/src/importer/cli.js repair --plan repair-plan.local.json --max-ms 86400000
```

The repair command requires the pause marker and the daemon lock. The importer service must remain stopped.

The queue is bounded to twice the configured document concurrency. Completed work frees space for new targets, so a slow document does not stop all other submissions. The worker checks live classification again before each new submission.

The previous remote hash must match the reviewed state or the known in-progress replacement. Unexpected remote changes stop repair. Pending and uncertain remote operations continue to block newer versions of the same document.

Repairs consolidate after extraction finishes, rather than repeatedly invalidating and rebuilding the same shared observations between small batches. Failed operations or consolidation items stop the run.

Progress is written to `reports/repair-progress.json` under the state directory. Logs report counts and operation state, not transcript text.

## Interruption and errors

The same plan can resume completed and partially completed work:

```bash
node dist/src/importer/cli.js repair --plan repair-plan.local.json --max-ms 86400000
```

Inspect errors first. After correcting a temporary failure, explicitly reset failed generations if needed:

```bash
node dist/src/importer/cli.js retry-failed
```

A lost response retries the same immutable payload and operation ID. A known terminal failure uses a fresh retry identity. Do not remove failed pending payloads while they may still be needed for recovery.

Do not rebuild or replace the running repair's JavaScript files. Use a fixed release checkout or a verified build snapshot for a long repair.

## Final verification and restart

Run a final scan after source writers are quiet. Process any new changes, enable automatic consolidation, and wait until Hindsight is idle:

```bash
node dist/src/importer/cli.js scan --force
node dist/src/importer/cli.js process-queued --max-ms 86400000
node dist/src/importer/cli.js enable-auto-consolidation
node dist/src/importer/cli.js consolidate
node dist/src/importer/cli.js verify-ready
```

`activationReady` verifies data and source coverage while the service is stopped. `continuousReady` also requires a live, unpaused importer without a recorded cycle error. Active-session deferrals prevent a claim of complete current coverage; they are not failed imports.

Before normal operation, also check representative corrections, exact values, original citations, and unanswered questions. A zero-length queue is not a quality test.

```bash
node dist/src/importer/cli.js resume
scripts/importer-service.sh start
```

Fully restart existing Pi processes to load the updated tool and status provider.
