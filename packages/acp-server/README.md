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

## Experimental endpoints

- `POST /v1/tasks/:taskId/promote` promotes a bare wrkq task into ACP preset control,
  assigns roles, and appends an initial promotion transition.

- `POST /v1/sessions/launch` launches a role-scoped run by loading task context,
  threading it into `runtimeIntent.taskContext`, and invoking the configured
  `launchRoleScopedRun` dependency.
