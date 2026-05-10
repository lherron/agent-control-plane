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

### Task lifecycle

- `POST /v1/tasks` — create a durable workflow task pinned to a workflow
  definition id/version/hash.
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

### Supervisor runs and actions (H — supervisor actions + auth hardening)

- `POST /v1/workflow-supervisor-runs` — start or resume a bounded supervisor
  run. Supports inline task creation. Starting a supervisor run is a **hard
  prerequisite** for any control action — the persisted supervisor run record
  is the sole source of capability authorization.

- `POST /v1/tasks/:taskId/actions` — submit a supervisor control action.
  Capabilities are derived from the persisted supervisor run record and
  **cannot be overridden via request body**. The `--capabilities` flag on the
  CLI is accepted for backwards compatibility but its value is ignored.

  Supported action types:

  | Action type | Capability required | Description |
  | --- | --- | --- |
  | `satisfy_obligation` | `satisfyObligations` | Satisfy a blocking obligation with evidence refs |
  | `launch_participant_run` | `launchRuns` | Launch a participant run for a bound role/actor |
  | `attach_evidence` | `attachEvidence` | Attach evidence records on behalf of the supervisor |
  | `apply_transition` | `applySupervisorTransitions` | Apply a transition backed by participant-produced evidence |
  | `escalate` | `escalate` | Record an escalation anomaly |
  | `pause_supervision` | `pauseSupervision` | Pause the supervisor run; further actions return `supervisor_paused` |
  | `unpause_supervision` | `pauseSupervision` | Unpause a previously paused supervisor run |

  Request body:
  ```json
  {
    "supervisorRunId": "supv_001",
    "action": { "type": "attach_evidence", "evidence": [{ "kind": "...", "ref": "...", "summary": "..." }] },
    "idempotencyKey": "act:attach:v1",
    "expectedTaskVersion": 5,
    "contextHash": "abc123"
  }
  ```

  For `apply_transition`, the `action` payload must include `transitionId` and
  `evidenceRefs`. The kernel verifies each evidence record was attached by a
  participant run (not by the supervisor itself), the participant run's role
  appears in the transition's `by[]`, and the participant run's actor matches
  the current role binding. The resulting event records
  `authority='supervisor_from_participant_evidence'`.

### Patch proposals (I — workflow patch proposals)

- `GET /v1/tasks/:taskId/workflow-patch-proposals` — list patch proposals for
  a task. Query parameters: `status` (optional filter), `limit` (default 50).

  Response: `{ proposals: [{ proposalId, baseWorkflow, patchKind, status, createdBy, createdAt, sourceAnomalyIds, rationaleSummary }] }`.

- `GET /v1/workflow-patch-proposals/:proposalId` — show a single patch
  proposal with full `patch` and `replayExpectations` payloads.

  Response: `{ proposal: { proposalId, taskId, baseWorkflow, patchKind, status, createdBy, createdAt, sourceAnomalyIds, rationaleSummary, patch, replayExpectations } }`.

### Context compilation

- `POST /v1/tasks/:taskId/participant-context` — compile a command-oriented
  participant context for a given run, actor, role, and session.
- `POST /v1/tasks/:taskId/supervisor-context` — compile a command-oriented
  supervisor context with allowed control actions, suggestions, obligations,
  evidence, participant runs, anomalies, and exact command templates.

Legacy preset promotion, transition listing, and `toPhase` task mutation routes
have been removed as breaking changes.

## Experimental endpoints

- `POST /v1/sessions/launch` launches a role-scoped run by loading task context,
  threading it into `runtimeIntent.taskContext`, and invoking the configured
  `launchRoleScopedRun` dependency.
