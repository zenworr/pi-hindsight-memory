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

The requester owns polling and rendering. A 15-second interval is normally sufficient. Requests have a bounded four-second collection deadline. The response never includes credentials, transcript text, recalled memory, or provider responses.

`pendingConsolidation` counts extracted memory units awaiting consolidation; it is not a count of consolidation jobs. `consolidationActive` indicates that pending units and a processing Hindsight operation are both present.
