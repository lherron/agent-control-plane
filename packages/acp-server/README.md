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

> **W6a (Phase 6):** The obsolete ACP-authoritative workflow routes were removed
> — task creation (`POST /v1/tasks`), workflow publish (`POST /v1/workflows`),
> supervisor runs/actions (`POST /v1/workflow-supervisor-runs`,
> `POST /v1/tasks/:taskId/actions`), context compilation
> (`POST /v1/tasks/:taskId/{participant,supervisor}-context`), and the
> patch-proposal read routes. Task authority is now wrkf; the remaining
> `/v1/tasks/:taskId` routes below are thin wrkf facades.

### Task lifecycle

- `GET /v1/tasks/:taskId` — return the full task snapshot (state, events,
  evidence, obligations, effects, supervisor runs, participant runs, anomalies,
  and patch proposals).
- `POST /v1/tasks/:taskId/transitions` — apply a workflow `transitionId`
  mutation with role-based authorization, evidence requirements, and SoD checks.

### Evidence (E1 — standalone attach with provenance)

- `POST /v1/tasks/:taskId/evidence` — attach one or more evidence records to a
  workflow task. Three authorization sources are supported:
  1. **Role-bound actor** — an actor whose `actorAgentId` matches a persisted
     role binding for the supplied `role`.
  2. **Supervisor** — an actor with `attachEvidence` capability on the
     persisted supervisor run (pass `supervisorRunId`).
  3. **Participant run** — an actor with a persisted participant run on the
     task (pass `participantRunId`).

  Each evidence record captures provenance fields (`actor`, `role?`, `runId?`,
  `participantRunId?`, `supervisorRunId?`) and round-trips them through
  persistence. Workflow-defined `evidenceKinds` are enforced — unknown kinds
  return `invalid_evidence`.

  Idempotency: same `idempotencyKey` + same payload replays the original
  response; same key + different payload returns `409 idempotency_conflict`.

  Request body:
  ```json
  {
    "evidence": [{ "kind": "commit_ref", "ref": "git:abc123", "summary": "..." }],
    "role": "implementer",
    "runId": "run_001",
    "supervisorRunId": "supv_001",
    "participantRunId": "prun_001",
    "expectedTaskVersion": 3,
    "idempotencyKey": "ev:attach:v1"
  }
  ```
  Actor is resolved from the `x-acp-actor-agent-id` header or `actor` body
  field. Response: `201` (new) or `200` (replay) with
  `{ evidence: [{ evidenceId }] }`.

### Obligations (E2 — waive and cancel lifecycle)

- `POST /v1/tasks/:taskId/obligations/:obligationId/waive` — waive a blocking
  obligation with a reason and optional `evidenceRefs`. Produces a waiver
  record that the kernel matches against `Requirement{type:'waiver'}` on
  subsequent transitions. Requires the actor to be the supervisor or an
  authorized role-bound actor with appropriate capability.

  Request body:
  ```json
  {
    "reason": "Low-risk change covered by §4.2",
    "evidenceRefs": ["evd_001"],
    "idempotencyKey": "obl:waive:v1"
  }
  ```
  Response: `{ task, obligation }`.

- `POST /v1/tasks/:taskId/obligations/:obligationId/cancel` — cancel
  (supersede) an obligation. Cancellation does NOT satisfy waiver requirements
  — this distinction is enforced by the kernel.

  Request body:
  ```json
  {
    "reason": "Superseded by direct cleanup pipeline run.",
    "idempotencyKey": "obl:cancel:v1"
  }
  ```
  Response: `{ task, obligation }`.

  Both mutations are idempotent under the standard key + payload fingerprint
  rule. `ObligationRecord.status` supports `open|satisfied|waived|cancelled|expired`.

### Participant runs (G — participant runtime)

- `POST /v1/workflow-participant-runs` — launch or resume a participant run.
  The kernel rejects requests where the body `actor` does not match the
  persisted role binding (`role_not_bound`). No role self-claim is allowed via
  this surface.

  Request body:
  ```json
  {
    "taskId": "T-001",
    "role": "implementer",
    "actor": { "kind": "agent", "id": "larry" },
    "harness": { "kind": "codex" },
    "idempotencyKey": "run:launch:v1",
    "resume": false
  }
  ```
  Response: `201` (new) or `200` (resume/replay) with
  `{ participantRun: { runId, kind, taskId, role, actor, status, taskVersionAtStart, contextHash, createdAt }, context }`.

  Participant run statuses: `launched|running|completed|failed|cancelled`.

- `POST /v1/workflow-participant-runs/:runId/complete` — complete a participant
  run with an outcome and optional evidence references.

  Request body:
  ```json
  {
    "outcome": "success",
    "evidenceRefs": ["evd_001", "evd_002"],
    "summary": "All tests passing",
    "idempotencyKey": "run:complete:v1"
  }
  ```

- `POST /v1/workflow-participant-runs/:runId/fail` — fail a participant run.

  Request body:
  ```json
  {
    "reason": "Compilation error in module X",
    "classification": "build_failure",
    "idempotencyKey": "run:fail:v1"
  }
  ```

### Supervisor runs, actions, patch proposals, and context compilation

These ACP-authoritative routes — `POST /v1/workflow-supervisor-runs`,
`POST /v1/tasks/:taskId/actions`, the `…/workflow-patch-proposals` read routes,
and `POST /v1/tasks/:taskId/{participant,supervisor}-context` — were removed in
W6a (Phase 6 of the Canonical Workflow Refactor) as the task lifecycle moved to
wrkf authority. Legacy preset promotion, transition listing, and `toPhase` task
mutation routes were removed earlier as breaking changes.

## Experimental endpoints

- `POST /v1/sessions/launch` launches a role-scoped run by loading task context,
  threading it into `runtimeIntent.taskContext`, and invoking the configured
  `launchRoleScopedRun` dependency.
