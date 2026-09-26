# Status integration

Pi extensions can request operational status without reading the Hindsight token, calling its API directly, or depending on the importer database schema.

Emit this shared event:

```text
pi-hindsight-memory:status:request:v1
```

The request carries a synchronous callback that receives an asynchronous snapshot:

```ts
interface StatusRequest {
  protocolVersion: 1;
  respond(status: Promise<StatusSnapshot>): void;
}

let response: Promise<StatusSnapshot> | undefined;
pi.events.emit("pi-hindsight-memory:status:request:v1", {
  protocolVersion: 1,
  respond(status: Promise<StatusSnapshot>) {
    response = status;
  },
});

if (!response) {
  // The memory extension is unavailable.
} else {
  const snapshot = await response;
}
```

The snapshot shape is:

```ts
interface StatusSnapshot {
  protocolVersion: 1;
  fetchedAt: string;
  apiUrl: string;
  uiUrl?: string;
  bankId: string;
  importer: {
    queued: number;
    submitted: number;
    processing: number;
    failed: number;
    cleanupPending: number;
    running: boolean;
    paused: boolean;
    heartbeatAt?: string;
    phase?: string;
    lastError?: string;
    scanErrors: number;
    deferred: number;
    unprocessed: number;
    staleSources: number;
    uncertain: number;
  };
  service: {
    healthy: boolean;
    databaseConnected: boolean;
    documents: number;
    pendingOperations: number;
    processingOperations: number;
    failedOperations: number;
    pendingConsolidation: number;
    failedConsolidation: number;
    consolidationActive: boolean;
  };
  issues: string[];
}
```

The requester owns polling and rendering. A 15-second interval is normally sufficient. The provider is session-scoped, so a request made while Pi is starting or reloading can have no immediate responder; retry it after session startup completes. Requests have a bounded four-second collection deadline. Concurrent requests share one collection; the provider does not cache completed snapshots. Importer counts and health come from one read-only SQLite snapshot, without a child process. The response never includes credentials, transcript text, recalled memory, or provider responses.

Importer issues include pause, missing or stale heartbeat, stale scans, recorded cycle errors, source errors, and uncertain remote operations. `deferred` counts sessions waiting for a stable source fingerprint; it is informational, not a failed operation. A consumer can display it as a separate settling count.

Display current failures as `importer.failed + service.failedConsolidation`. Do not add `service.failedOperations`: it counts retained terminal operation history, including failures followed by successful retries. That history is for diagnostics, not the status bar. Do not show a resolved-failure message.

The daemon retries failed cycles after 30 seconds, independent of the full scan interval. After a successful recovery check, it clears `lastError` and publishes the new heartbeat immediately. An unresolved update, document mismatch, or scan error remains visible. If a status request fails, show that status is unavailable instead of displaying old counters as current.

`pendingConsolidation` counts extracted memory units awaiting consolidation; it is not a count of consolidation jobs. `consolidationActive` is true only when Hindsight reports a processing operation whose task type is `consolidation`.
