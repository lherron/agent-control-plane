# acp-server

ACP HTTP server for admin state, interfaces, inputs, coordination messages,
runtime/session resolution, jobs, deliveries, mobile/dashboard views, and
wrkf-backed workflow task facades.

## Running the server

Start the local dev server with:

```bash
acp-server
```

Environment variables:

- `ACP_WRKQ_DB_PATH` — defaults to `WRKQ_DB_PATH`
- `ACP_COORD_DB_PATH` — defaults to `/Users/lherron/praesidium/var/db/acp-coordination.db`
- `ACP_INTERFACE_DB_PATH` — defaults to `/Users/lherron/praesidium/var/db/acp-interface.db`
- `ACP_STATE_DB_PATH` — defaults to `/Users/lherron/praesidium/var/db/acp-state.db`
- `ACP_ADMIN_DB_PATH`, `ACP_JOBS_DB_PATH`, `ACP_CONVERSATION_DB_PATH` — optional DB overrides
- `ACP_AGENT_ASSETS_DIR` — defaults to `/Users/lherron/praesidium/var/state/acp-server/assets/agents`
- `ACP_HOST` — comma-separated bind host list; defaults to `127.0.0.1`
- `ACP_PORT` — defaults to `18470`
- `ACP_ACTOR` — defaults to `WRKQ_ACTOR` or `acp-server`
- `WRKF_BIN` — defaults to `wrkf`
- `WRKF_DB_PATH` — defaults to the ACP wrkq DB path
- `ACP_WRKF_DISABLED` — set `1` or `true` to bypass wrkf startup in local dev/test

Check wrkf availability through the running server:

```bash
curl -sS http://127.0.0.1:18470/v1/wrkf/ping
```

## Workflow endpoints

> **W6a (Phase 6):** The obsolete ACP-authoritative workflow routes were removed
> — task creation, workflow publish, supervisor runs/actions, context
> compilation, and patch-proposal read routes. Task authority is now wrkf; the
> remaining `/v1/tasks/:taskId` routes below are thin wrkf facades.

### Task lifecycle

- `GET /v1/tasks/:taskId` — wrkf facade. Returns
  `{ source: "wrkf", task, instance, next, timeline, evidence, obligations, effects, runs }`.
- `POST /v1/tasks/:taskId/transitions` — delegates to wrkf `transition.apply`.
  Legacy `expectedTaskVersion` is mapped to wrkf `expectRevision`; legacy
  inline evidence fields are not workflow authority.

### Evidence

- `POST /v1/tasks/:taskId/evidence` — delegates to wrkf `evidence.add`.
  ACP accepts the legacy CLI body shape, but the server sends only wrkf fields:
  `task`, `kind`, `ref`, `actor`, optional `summary`, optional `facts`, and
  optional `role`.

  Request body:
  ```json
  {
    "kind": "commit_ref",
    "ref": "git:abc123",
    "summary": "optional summary",
    "role": "implementer",
    "actor": { "kind": "agent", "id": "larry" }
  }
  ```
  Response: `201` with `{ "evidence": ... }`.

### Obligations

- `POST /v1/tasks/:taskId/obligations/:obligationId/waive` — waive a blocking
  obligation through wrkf `obligation.waive`.

  Request body:
  ```json
  {
    "reason": "Low-risk change covered by policy"
  }
  ```
  Response: wrkf result.

- `POST /v1/tasks/:taskId/obligations/:obligationId/cancel` — cancel
  (supersede) an obligation through wrkf `obligation.cancel`.

  Request body:
  ```json
  {
    "reason": "Superseded by direct cleanup pipeline run."
  }
  ```
  Response: wrkf result.

### Participant runs

- `POST /v1/workflow-participant-runs` — launch or resume a participant run.
  ACP starts a wrkf run, launches HRC through the role-scoped launcher, records
  ACP execution metadata, and binds external HRC identifiers back to wrkf.

  Request body:
  ```json
  {
    "taskId": "T-001",
    "role": "implementer",
    "actor": { "kind": "agent", "id": "larry" },
    "idempotencyKey": "run:launch:v1",
    "sessionRef": {
      "scopeRef": "agent:larry:project:agent-control-plane:task:T-001",
      "laneRef": "main"
    }
  }
  ```
  Response: wrkf/ACP launch result, `201` for a new launch or `200` for replay.

- `POST /v1/workflow-participant-runs/:runId/complete` — complete a participant
  run through wrkf `run.finish`.

  Request body:
  ```json
  {
    "summary": "All tests passing"
  }
  ```

- `POST /v1/workflow-participant-runs/:runId/fail` — fail a participant run
  through wrkf `run.fail`.

  Request body:
  ```json
  {
    "reason": "Compilation error in module X",
    "classification": "build_failure"
  }
  ```

### Supervisor runs, actions, patch proposals, and context compilation

The ACP-authoritative supervisor-run, action, patch-proposal, and context
compilation route families were removed in W6a (Phase 6 of the Canonical
Workflow Refactor) as the task lifecycle moved to wrkf authority. Legacy preset
promotion, transition listing, and `toPhase` task mutation routes were removed
earlier as breaking changes.

## Experimental endpoints

- `POST /v1/sessions/launch` launches a role-scoped run by loading task context,
  threading it into `runtimeIntent.taskContext`, and invoking the configured
  `launchRoleScopedRun` dependency.
