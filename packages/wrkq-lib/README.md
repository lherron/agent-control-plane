# `wrkq-lib`

Thin TypeScript repositories over an existing `wrkq.db` for ACP task workflow data.

- Opens an already-migrated wrkq SQLite file; it never runs DDL or migrations.
- Stores ACP task kind in `tasks.meta` under `acp.kind`; the remaining `Task.meta` payload stays alongside it.
- Resolves the store actor from `actors.slug` and creates the actor lazily when missing.

Use `openWrkqStore({ dbPath, actor })` to get `taskRepo`, `evidenceRepo`, `roleAssignmentRepo`, `transitionLogRepo`, and `runInTransaction()`.
