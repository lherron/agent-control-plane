# `wrkq-lib`

Thin async adapter that maps `@wrkq/client` RPC (the `wrkq` + `wrkf` namespaces)
onto acp-core's four store ports — `TaskStore`, `EvidenceStore`,
`RoleAssignmentStore`, and `TransitionLogStore`.

- It is mapping GLUE ONLY: no SQLite, no migrations, no transactions, no actor
  resolution, no schema-presence checks. ACP never opens or infers `wrkq.db`;
  wrkq/wrkf is the sole authority for task/workflow/role/evidence/transition
  state, reached exclusively over `@wrkq/client`.
- RPC failures surface as the client's `WorkRpcError`; the HTTP/CLI boundary
  translates `domainCode` → 404/409/422.

Use `createWrkqStoreAdapter(client)` (one shared `WorkClient` per process) to get
`{ taskStore, evidenceStore, roleAssignmentStore, transitionLogStore }`.
