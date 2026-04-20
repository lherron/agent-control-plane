# coordination-substrate

SQLite-backed immutable coordination ledger for ACP MVP handoffs and wake requests.

Primary surface:

- `openCoordinationStore(dbPath)`
- `appendEvent(store, cmd)`
- `listEvents`, `listOpenHandoffs`, `listPendingWakes`, `listEventLinks`
- `leaseWake`, `consumeWake`, `cancelWake`
- `acceptHandoff`, `completeHandoff`, `cancelHandoff`
