# acp-server

Minimal ACP HTTP surface for tasks, transitions, inputs, coordination messages, and runtime/session resolution seams.

## Running the server

Start the local dev server with:

```bash
acp-server
```

Environment variables:

- `ACP_WRKQ_DB_PATH` — defaults to `WRKQ_DB_PATH`
- `ACP_COORD_DB_PATH` — defaults to `/Users/lherron/praesidium/var/db/acp-coordination.db`
- `ACP_HOST` — defaults to `127.0.0.1`
- `ACP_PORT` — defaults to `18470`
- `ACP_ACTOR` — defaults to `WRKQ_ACTOR` or `acp-server`

## Workflow endpoints

- `POST /v1/tasks` creates a durable workflow task pinned to a workflow
  definition id/version/hash.
- `GET /v1/tasks/:taskId` returns the durable workflow task snapshot.
- `POST /v1/tasks/:taskId/transitions` applies a workflow `transitionId`
  mutation.
- `POST /v1/tasks/:taskId/actions` applies a supervisor workflow control
  action.
- `POST /v1/workflow-supervisor-runs` starts or resumes a bounded workflow
  supervisor run and returns the compiled SupervisorContext.
- `POST /v1/tasks/:taskId/participant-context` and
  `POST /v1/tasks/:taskId/supervisor-context` return command-oriented workflow
  contexts.

Legacy preset promotion, evidence attachment, transition listing, and `toPhase`
task mutation routes have been removed as breaking changes.

## Experimental endpoints

- `POST /v1/sessions/launch` launches a role-scoped run by loading task context,
  threading it into `runtimeIntent.taskContext`, and invoking the configured
  `launchRoleScopedRun` dependency.
