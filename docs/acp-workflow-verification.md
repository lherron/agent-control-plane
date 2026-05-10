# ACP Workflow Verification

> ## ⚠️ Real-agent execution required
>
> All manual scenario validation MUST be driven by real agent runtimes. An
> operator issuing CLI commands with `--as agent:X` validates the CLI surface
> but is **NOT** acceptance evidence for workflow correctness.
>
> ### Required execution pattern
>
> Instead of an operator running commands like:
>
> ```bash
> # ❌ NOT acceptable — operator-CLI walk
> acp task evidence add --task T-001 --kind field_note --ref note:x \
>   --as agent:larry --role collector --idempotency-key ev:v1
> ```
>
> The correct approach uses real agent dispatch:
>
> ```bash
> # ✅ Supervisor agent (rex) dispatches participant
> hrcchat dm larry@agent-spaces:T-001/collector - <<'EOF'
> You are assigned the collector role on T-001.
> Execute: acp task evidence add --task T-001 --kind field_note \
>   --ref note:x --role collector --idempotency-key ev:v1
> Reply with the evidence ID when done.
> EOF
>
> # larry executes in its own hrc session and replies with evidence ID
> # rex confirms via: acp task show --task T-001
> ```
>
> See [`scenarios/flow-presets/README.md`](../scenarios/flow-presets/README.md)
> for the full policy and
> [`docs/acp-supervisor-playbook.md`](./acp-supervisor-playbook.md) for the
> canonical supervisor dispatch protocol.

## Checkpoints

### 2026-05-09

- Invariant map completed in `tests/conformance/acp-workflow/README.md`.
- Executable conformance suite added in
  `tests/conformance/acp-workflow/workflow-kernel.conformance.test.ts`.
- Golden participant and supervisor context fixtures added under
  `tests/conformance/acp-workflow/golden/`.
- Workflow fixtures cover generic, code defect, and non-code external approval
  scenarios.
- `acp-core` now exports an in-memory workflow kernel that verifies the proposal
  behaviors: immutable workflow definition publication, task state invariants,
  transition identity, evidence requirements, role authorization, separation of
  duties, idempotency fences, version/context hashes, obligations, effect intents,
  participant context, supervisor context/actions, anomalies, and patch proposals.
- The root `bun run test` script now runs the ACP workflow conformance suite
  before the package test graph, making it part of the canonical repository check.

## Commands And Results

| Command | Result |
| --- | --- |
| `bun test tests/conformance/acp-workflow` before implementation | Failed as expected because `packages/acp-core/src/workflow/index.js` did not exist. |
| `bun test tests/conformance/acp-workflow` | Passed: 31 tests, 566 assertions. |
| `bun scripts/validate-scenarios.ts` | Passed with final line `>>> OVERALL: SCENARIO-VALIDATION PASS`. |
| `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` | Passed: 16 tests, 492 assertions. |
| `bun test packages/acp-cli/test/commands/task-workflow.test.ts` | Passed: 9 tests, 29 assertions. |
| `bun test packages/acp-server/test/workflow-tasks.test.ts` | Passed: 4 tests, 32 assertions. |
| `bun run --filter acp-core typecheck` | Passed. |
| `bun run --filter acp-cli typecheck` | Passed. |
| `bun run --filter acp-server typecheck` | Passed. |
| `bun run --filter acp-state-store typecheck` | Passed. |
| `bun run --filter acp-core build` | Passed. |
| `bun run --filter acp-core test` | Passed: 48 tests, 151 assertions. |
| `bun run lint` | Passed with one existing warning in `packages/gateway-discord/src/session-events-manager.ts` for cognitive complexity. |
| `bun run typecheck` | Passed across the workspace. |
| `bun run build` | Passed across the workspace. |
| `bun run test` | Did not complete cleanly in this session because unrelated 5s timeout tests fired under the broad package graph: first in `hrc-server`, then in `@lherron/agent-spaces`. The failing tests passed when rerun directly, and both packages passed when rerun package-scoped. |
| `bun run --filter hrc-server test` | Passed on rerun: 289 tests, 1099 assertions. |
| `bun test packages/cli/src/__tests__/m6-agent-cli.test.ts -t "--host-session-id sets AGENT_HOST_SESSION_ID alongside scope/lane"` | Passed on rerun. |
| `bun run --filter @lherron/agent-spaces test` | Passed on rerun: 121 tests, 287 assertions. |
| `hrcchat show 1649` | Clod reported `SCENARIO-VALIDATION PASS` for `bun scripts/validate-scenarios.ts`, covering all three scenario folders, three happy paths, and 12 negative checks. |
| `hrcchat show 1650` | Clod reported `SCENARIO-VALIDATION PASS` for `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` with 16 tests/492 assertions. |
| `hrcchat show 1653` | Clod reported the stricter live-supervisor case was not covered by the kernel-level scenario runners. |
| `hrcchat show 1654` | Rex reported `PASS` for the stricter supervisor-agent path: `agent:rex` fetched supervisor context and satisfied `customer_response_pending` through the durable ACP HTTP action surface on an isolated SQLite-backed source server. |
| `asp run supervisor --dry-run` | Passed. The new `supervisor` agent prompt/profile assembled successfully. |
| Manual installed-CLI smoke on `127.0.0.1:18481` | Passed. `acp supervise` created `T-D9904DF5` and supervisor run `supv_0002`; `acp workflow supervise` resumed it with `launch_participant_run` allowed; `acp workflow action` launched owner participant `cody`; `acp task show` reported 3 supervisor runs, 1 participant run, and 1 effect. |

## Model Boundary

The conformance kernel treats workflow state as the durable source of truth:
tasks pin `workflow.id`, `workflow.version`, and `workflow.hash`; state is modeled
as `open`, `active`, `waiting`, or `closed` plus phase/outcome; mutations use
`transitionId` and idempotency keys.

The server task workflow route surface has migrated away from legacy
`workflowPreset`, `presetVersion`, `lifecycleState`, and `toPhase` semantics.
`POST /v1/tasks` now creates durable workflow-kernel tasks, and
`POST /v1/tasks/:taskId/transitions` now applies `transitionId` mutations through
the kernel. The removed server routes are task evidence attachment, wrkq promote,
legacy transition listing, and `toPhase` mutation.

The CLI treats this as a breaking change: legacy task promote, evidence-add, and
transition-list commands/tests were removed. Compatibility HTTP-client methods
that still exist for old mocks now fail explicitly instead of calling removed
routes.

The server also treats this as a breaking change: old task create/get/evidence/
promote/transition/transition-list handler files were removed from source, and
`packages/acp-server/README.md` documents the workflow route surface instead of
the legacy promote endpoint.

Legacy wrkq task models, old preset validators, and some direct helper tests
remain in the repo for non-migrated surfaces. They are not the primary workflow
truth for the new task route surface.

## Durable Runtime Checkpoint

### 2026-05-09

- Added built-in workflow definitions for `basic@1`,
  `code_defect_fastlane@1`, and `code_feature_tdd@1`.
- Added kernel snapshot hydrate/export so conformance semantics can be persisted.
- Added workflow runtime tables to `acp-state-store` for definitions, tasks,
  evidence, obligations, events, effects, participant runs, anomalies, patch
  proposals, idempotency records, context hashes, and sequence metadata.
- Added workflow task create/get/transition/action/context handlers to
  `acp-server`.
- Added `/v1/workflow-supervisor-runs` to start or resume bounded workflow
  supervisor runs and persist `workflow_supervisor` run links.
- Updated `acp-cli task create`, `task show`, `task transition`,
  `workflow supervise`, `workflow supervisor-context`, `workflow action`, and
  the top-level `supervise` alias to the new workflow task API.
- Added workflow effect reconciliation from durable `EffectIntent` rows into
  CoordinationSubstrate handoff and wake rows, with delivery status updates.
- Added supervisor participant launch wake emission for role-scoped participant
  sessions.
- Removed the legacy server task handler files for old task create/get/evidence/
  promote/transition/transition-list routes.
- Added `tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` to
  execute every scenario artifact in `scenarios/flow-presets`.
- Added `scripts/validate-scenarios.ts`, the independent harness used by Clod
  for external validation.
- Updated scenario runbooks and negative-check prose to remove legacy task route
  commands and match the earlier SoD rejection points enforced by the workflow.

Commands:

| Command | Result |
| --- | --- |
| `bun scripts/validate-scenarios.ts` | Passed with final line `>>> OVERALL: SCENARIO-VALIDATION PASS`. |
| `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` | Passed: 16 tests, 492 assertions. |
| `bun test tests/conformance/acp-workflow` | Passed: 31 tests, 566 assertions. |
| `bun test tests/conformance/acp-workflow/workflow-kernel.conformance.test.ts` | Passed: 15 tests, 74 assertions. |
| `bun test packages/acp-cli/test/commands/task-workflow.test.ts` | Passed: 9 tests, 29 assertions. |
| `bun run --filter acp-core test` | Passed: 48 tests, 151 assertions. |
| `bun run --filter acp-state-store test` | Passed: 4 tests, 19 assertions. |
| `bun test packages/acp-server/test/workflow-tasks.test.ts` | Passed: 4 tests, 32 assertions. |
| `bun run --filter acp-server test` | Passed: 376 tests, 1498 assertions. |
| `bun run --filter acp-cli test` | Passed: 130 tests, 491 assertions. |
| `bun run --filter acp-e2e test` | Passed: 14 tests, 121 assertions. |
| `bun run --filter acp-core typecheck` | Passed. |
| `bun run --filter acp-state-store typecheck` | Passed. |
| `bun run --filter acp-server typecheck` | Passed. |
| `bun run --filter acp-cli typecheck` | Passed. |
| `bun run --filter acp-core build` | Passed. |
| `bun run --filter acp-state-store build` | Passed. |
| `bun run --filter acp-server build` | Passed. |
| `bun run --filter acp-cli build` | Passed. |
| `bun run lint` | Passed with one pre-existing warning in `packages/gateway-discord/src/session-events-manager.ts`. |
| `bun run typecheck` | Passed across the workspace. |
| `bun run build` | Passed across the workspace. |
| `bun run test` | Did not complete cleanly in this session because unrelated 5s timeout tests fired under the broad package graph; the failing tests and packages passed on focused reruns. |
| `bun run --filter hrc-server test` | Passed on rerun: 289 tests, 1099 assertions. |
| `bun test packages/cli/src/__tests__/m6-agent-cli.test.ts -t "--host-session-id sets AGENT_HOST_SESSION_ID alongside scope/lane"` | Passed on rerun. |
| `bun run --filter @lherron/agent-spaces test` | Passed on rerun: 121 tests, 287 assertions. |
| `hrcchat show 1649` | Clod reported `SCENARIO-VALIDATION PASS` for the independent harness. |
| `hrcchat show 1650` | Clod reported `SCENARIO-VALIDATION PASS` for the repo-native scenario conformance test. |
| `hrcchat show 1653` | Clod reported `FAIL` for the stricter live-supervisor interpretation because the scenario runners use direct kernel calls with synthetic supervisor run ids. |
| `hrcchat show 1654` | Rex reported `PASS` for the stricter supervisor-agent path on the current source HTTP surface: `agent:rex` compiled supervisor context and submitted `satisfy_obligation`; the task persisted version 4 with `customer_response_pending` satisfied and event actor `agent:rex`. |
| Manual CLI smoke on source ACP server at `127.0.0.1:18479` | Passed: `acp workflow supervisor-context` returned one allowed `satisfy_obligation` action, `acp workflow action` satisfied `obl_0009`, and readback showed `T-CODY-SUPP1 v4 obligation=satisfied actor=agent:rex`. |
| `asp run supervisor --dry-run` | Passed. The new `supervisor` agent prompt/profile assembled successfully. |
| Manual installed-CLI smoke on source ACP server at `127.0.0.1:18481` | Passed: `acp supervise` created `T-D9904DF5` and supervisor run `supv_0002`; `acp workflow supervise` resumed it and preserved inherited `launchRuns`; `acp workflow action` launched owner participant `cody`; `acp task show` reported 3 supervisor runs, 1 participant run, and 1 effect. |

Caveats:

- Workflow `EffectIntent` delivery into CoordinationSubstrate is implemented for
  handoff and wake intents. A live HRC process launch caused by a workflow wake
  was not run in this checkpoint.
- The stricter live-supervisor scenario passes against the current checkout's
  source server and isolated durable DBs. The already-running shared dev ACP on
  `127.0.0.1:18470` was stale during validation and still served the old
  `roleMap` route shape until restarted/upgraded.
- Legacy wrkq task models and old preset validators remain for non-migrated
  helper paths, and internal transition-outbox repair code still uses old phase
  field names. The server/CLI task workflow route surface no longer uses the
  legacy task workflow routes.
- External scenario execution via `hrcchat dm clod@agent-spaces` was completed
  on 2026-05-10. Clod validated all scenarios with the independent harness and
  the repo-native scenario conformance test; both returned
  `SCENARIO-VALIDATION PASS`.

## Workflow Publish (T-01400 Stream B)

### Endpoint

- `POST /v1/workflows` — publishes or re-publishes an immutable workflow
  definition from a JSON file. Returns the definition with `id`, `version`,
  and `hash`.

### CLI

- `acp workflow publish <workflow.json>` — reads a workflow definition JSON
  file and publishes it to the server. Required precondition before creating
  tasks that reference the workflow.

### Example

```bash
acp workflow publish ./scenarios/flow-presets/evidence-provenance-attach/workflow.json
# → Published workflow evidence_provenance_demo@1 (sha256:...)
```

## E1 — Evidence provenance + standalone attach (T-01392)

### Endpoints

- `POST /v1/tasks/:taskId/evidence` — standalone evidence attach with
  3-source authorization (role-bound, supervisor, participant run), provenance
  fields, and idempotency.

### CLI

- `acp task evidence add --task <id> --kind <kind> --ref <ref> --idempotency-key <key> [--role <role>] [--supervisor-run <id>] [--from-run <runId>] [--as <agent>] [--summary <text>]`

### Verification recipes

```bash
# Unit tests — kernel evidence provenance
bun test tests/conformance/acp-workflow/evidence-provenance.test.ts
# 2 tests, 8 expect() calls

# Server integration — evidence attach handler
bun test packages/acp-server/test/evidence-attach.test.ts
# 5 tests, 26 expect() calls

# CLI integration — evidence add command
bun test packages/acp-cli/test/commands/evidence-add.test.ts
# 1 test, 7 expect() calls

# Scenario — evidence-provenance-attach
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

### Curl example — attach evidence as role-bound actor

```bash
curl -s -X POST http://127.0.0.1:18470/v1/tasks/T-001/evidence \
  -H 'content-type: application/json' \
  -H 'x-acp-actor-agent-id: larry' \
  -d '{
    "evidence": [{"kind":"commit_ref","ref":"git:abc123"}],
    "role": "implementer",
    "idempotencyKey": "ev:attach:v1"
  }'
```

### Scenario runbook

See `scenarios/flow-presets/evidence-provenance-attach/runbook.md` for the
full end-to-end walkthrough covering role-bound, supervisor, and participant
run evidence attach with idempotency replay and conflict checks.

## E2 — Obligation waive and cancel lifecycle (T-01393)

### Endpoints

- `POST /v1/tasks/:taskId/obligations/:obligationId/waive` — waive with
  reason + evidenceRefs. Produces a waiver record matched by
  `Requirement{type:'waiver'}`.
- `POST /v1/tasks/:taskId/obligations/:obligationId/cancel` — cancel with
  reason. Does NOT satisfy waiver requirements.

### CLI

- `acp task obligation waive --task <id> --obligation <id> --reason <text> --idempotency-key <key> [--evidence-ref <ref>]...`
- `acp task obligation cancel --task <id> --obligation <id> --reason <text> --idempotency-key <key>`

### Verification recipes

```bash
# Kernel conformance — obligation lifecycle
bun test tests/conformance/acp-workflow/obligation-lifecycle.conformance.test.ts
# 1 test, 5 expect() calls

# Kernel unit — obligation lifecycle
bun test packages/acp-core/src/__tests__/workflow-obligation-lifecycle.test.ts

# Server integration — waive/cancel handlers
bun test packages/acp-server/test/workflow-task-obligations.test.ts
# 2 tests, 12 expect() calls

# CLI integration — waive/cancel commands
bun test packages/acp-cli/test/commands/task-obligation-waive-cancel.test.ts
# 2 tests, 12 expect() calls

# Scenario — obligation-waive-cancel-lifecycle
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

### Curl example — waive obligation

```bash
curl -s -X POST http://127.0.0.1:18470/v1/tasks/T-001/obligations/obl_audit/waive \
  -H 'content-type: application/json' \
  -H 'x-acp-actor-agent-id: rex' \
  -d '{
    "reason": "Low-risk change covered by §4.2",
    "evidenceRefs": ["evd_waiver_doc"],
    "idempotencyKey": "obl:waive:v1"
  }'
```

### Scenario runbook

See `scenarios/flow-presets/obligation-waive-cancel-lifecycle/runbook.md`.

## G — Participant runtime create/resume (T-01394)

### Endpoints

- `POST /v1/workflow-participant-runs` — launch or resume a participant run.
  Rejects actor/role mismatches with `role_not_bound`.
- `POST /v1/workflow-participant-runs/:runId/complete` — complete a run.
- `POST /v1/workflow-participant-runs/:runId/fail` — fail a run.

### CLI

- `acp task run --task <id> --role <role> --agent <agent> [--idempotency-key <key>]`
  — launches a participant run. Uses `--agent` (or `--as` / `--actor`) for actor
  identity.
- `acp task run-complete --run <runId> --outcome <success|failed> [--evidence-ref <ref>]... [--summary <text>]`
  — completes a participant run with outcome and optional evidence references.

### Verification recipes

```bash
# Kernel conformance — participant runtime
bun test tests/conformance/acp-workflow/participant-runtime.conformance.test.ts
# 3 tests, 27 expect() calls

# Kernel unit — participant runtime
bun test packages/acp-core/src/__tests__/workflow-participant-runtime.test.ts

# Server integration — participant runs
bun test packages/acp-server/test/workflow-participant-runs.test.ts
# 4 tests, 24 expect() calls

# CLI integration — task run command
bun test packages/acp-cli/test/commands/task-run.test.ts
# 3 tests, 5 expect() calls

# Scenario — participant-supervisor-evidence-authority
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

### Curl example — launch participant run

```bash
curl -s -X POST http://127.0.0.1:18470/v1/workflow-participant-runs \
  -H 'content-type: application/json' \
  -H 'x-acp-actor-agent-id: larry' \
  -d '{
    "taskId": "T-001",
    "role": "implementer",
    "actor": {"kind":"agent","id":"larry"},
    "idempotencyKey": "run:launch:v1"
  }'
```

### Scenario runbook

See `scenarios/flow-presets/participant-supervisor-evidence-authority/runbook.md`.

## H — Supervisor actions + auth hardening (T-01396)

### Endpoints

- `POST /v1/tasks/:taskId/actions` — enhanced with new action types:
  `attach_evidence`, `apply_transition`, `escalate`, `pause_supervision`,
  `unpause_supervision`. Capabilities derive from the persisted supervisor run
  record and cannot be overridden via request body.
- `POST /v1/workflow-supervisor-runs` — starting a supervisor run is now a
  hard prerequisite for any control action.

### CLI

- `acp workflow action --task <id> --supervisor-run <id> --action '<json>' --idempotency-key <key>`
  — the `--capabilities` flag is accepted but ignored (auth hardening).

### Verification recipes

```bash
# Kernel conformance — supervisor actions + auth hardening
bun test tests/conformance/acp-workflow/supervisor-actions.conformance.test.ts
# 4 tests, 30 expect() calls

# Server integration — supervisor actions
bun test packages/acp-server/test/workflow-supervisor-actions.test.ts
# 4 tests, 23 expect() calls

# Scenario — participant-supervisor-evidence-authority
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

### Curl example — supervisor apply_transition

```bash
curl -s -X POST http://127.0.0.1:18470/v1/tasks/T-001/actions \
  -H 'content-type: application/json' \
  -H 'x-acp-actor-agent-id: rex' \
  -d '{
    "supervisorRunId": "supv_001",
    "action": {
      "type": "apply_transition",
      "transitionId": "implement_fix",
      "evidenceRefs": ["evd_commit","evd_test"]
    },
    "idempotencyKey": "act:apply:v1"
  }'
```

### Auth hardening details

The control action flow now requires:
1. Start a supervisor run via `POST /v1/workflow-supervisor-runs` (creates
   the persisted run record with capabilities).
2. Submit actions via `POST /v1/tasks/:taskId/actions` with
   `supervisorRunId` — capabilities are read from the persisted record.
3. Request-body capability claims are silently ignored.

### Scenario runbook

See `scenarios/flow-presets/participant-supervisor-evidence-authority/runbook.md`
for the combined G + H + E1 end-to-end scenario.

## I — Patch proposal read API (T-01395)

### Endpoints

- `GET /v1/tasks/:taskId/workflow-patch-proposals` — list with optional
  `status` filter and `limit`.
- `GET /v1/workflow-patch-proposals/:proposalId` — show full proposal.

### CLI

- `acp workflow patch list --task <id> [--status <s>] [--limit <n>]`
- `acp workflow patch show <proposalId> [--raw] [--json]`

### Verification recipes

```bash
# Server integration — patch proposal read
bun test packages/acp-server/test/workflow-patch-proposals-read.test.ts
# 3 tests, 29 expect() calls

# CLI integration — patch list/show
bun test packages/acp-cli/test/commands/workflow-patch-list-show.test.ts
# 4 tests, 18 expect() calls
```

### Curl example — list patch proposals

```bash
curl -s http://127.0.0.1:18470/v1/tasks/T-001/workflow-patch-proposals?limit=10
```

## Manual-execution scenarios

> **Note:** The CLI examples below illustrate the command surface. For
> acceptance validation, these commands must be executed by real agent runtimes
> using the supervisor→participant dispatch pattern described at the top of this
> file, not by an operator using `--as agent:X`.

Three manual-execution scenarios were added in commit `61d01fb`:

| Scenario folder | Checkpoints exercised | Runbook |
| --- | --- | --- |
| `evidence-provenance-attach/` | E1 | `scenarios/flow-presets/evidence-provenance-attach/runbook.md` |
| `obligation-waive-cancel-lifecycle/` | E2 | `scenarios/flow-presets/obligation-waive-cancel-lifecycle/runbook.md` |
| `participant-supervisor-evidence-authority/` | G + H + E1 | `scenarios/flow-presets/participant-supervisor-evidence-authority/runbook.md` |

Each scenario folder contains `workflow.json`, `scenario.json`, and
`runbook.md`. The scenarios are validated by the conformance harness:

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
bun scripts/validate-scenarios.ts
```

## End-to-end narrative: defect fastlane with participant + supervisor APIs

> **Note:** The CLI examples below illustrate the command surface. For
> acceptance validation, each command must be executed by the assigned real
> agent in its own `hrc` session — supervisor commands by rex, implementer
> commands by larry, tester commands by curly — via the dispatch pattern
> described at the top of this file.

This walkthrough demonstrates the `participant-supervisor-evidence-authority`
scenario — a code-change task driven by participant runs, supervisor
authority, and evidence provenance (G + H + E1 working together).

> **Note:** `acp task run` and `acp task run-complete` are fully wired into
> CLI dispatch as of T-01400 (Stream B). The commands below run verbatim.

**Setup:** Publish the workflow and create a supervised task with implementer
and tester roles.

```bash
# Publish workflow definition (required precondition)
acp workflow publish ./scenarios/flow-presets/participant-supervisor-evidence-authority/workflow.json

# Start supervisor run (creates task inline)
acp supervise \
  --workflow participant_supervisor_demo@1 \
  --project agent-spaces \
  --task-id T-DEFECT-DEMO \
  --goal "Fix nil order id guard" \
  --risk medium \
  --bind implementer=agent:larry \
  --bind tester=agent:curly \
  --supervisor agent:rex \
  --autonomy managed \
  --supervisor-capability launchRuns,attachEvidence,applySupervisorTransitions,pauseSupervision \
  --idempotency-key demo:create:v1
# → supervisor run supv_001 started
```

**Phase 1 — Implementer attaches plan and starts work:**

```bash
acp task evidence add \
  --task T-DEFECT-DEMO --kind plan_record --ref doc:plan-v1 \
  --summary "Plan: guard nil order id" \
  --as agent:larry --role implementer \
  --idempotency-key demo:plan:v1

acp task transition \
  --task T-DEFECT-DEMO --transition start \
  --as agent:larry --role implementer \
  --idempotency-key demo:start:v1
```

**Phase 2 — Implementer launches participant run, produces evidence:**

```bash
acp task run \
  --task T-DEFECT-DEMO --role implementer --agent larry \
  --idempotency-key demo:impl-run:v1
# → participant run prun_001 launched

acp task evidence add \
  --task T-DEFECT-DEMO --kind commit_ref --ref git:deadbeef \
  --as agent:larry --from-run prun_001 \
  --idempotency-key demo:commit:v1

acp task evidence add \
  --task T-DEFECT-DEMO --kind regression_test --ref test:orders.checkout \
  --as agent:larry --from-run prun_001 \
  --idempotency-key demo:test:v1
```

**Phase 3 — Supervisor applies transition using participant evidence:**

The supervisor's `apply_transition` action verifies each evidence record was
attached by a participant run, the participant's role appears in the
transition's `by[]`, and the actor matches the current binding. The resulting
event records `authority='supervisor_from_participant_evidence'`.

```bash
acp workflow action \
  --task T-DEFECT-DEMO --supervisor-run supv_001 \
  --action '{"type":"apply_transition","transitionId":"implement_fix","evidenceRefs":["evd_commit","evd_test"]}' \
  --idempotency-key demo:apply-impl:v1
# → Applied workflow action to T-DEFECT-DEMO; state=active/verify version=5
```

**Phase 4 — Tester verifies (role-mode transition, not supervisor-mode):**

```bash
acp task run \
  --task T-DEFECT-DEMO --role tester --agent curly \
  --idempotency-key demo:tester-run:v1

acp task evidence add \
  --task T-DEFECT-DEMO --kind verification_report --ref report:qa-2026 \
  --as agent:curly --from-run prun_002 \
  --idempotency-key demo:verify-evidence:v1

acp task transition \
  --task T-DEFECT-DEMO --transition verify \
  --as agent:curly --role tester \
  --idempotency-key demo:verify:v1
```

**Phase 5 — Close:**

```bash
acp task transition \
  --task T-DEFECT-DEMO --transition close_success \
  --as agent:larry --role implementer \
  --idempotency-key demo:close:v1
# → state=closed/completed
```

This narrative exercises: standalone evidence attach (E1), participant run
launch and evidence provenance (G), supervisor apply_transition with
participant-evidence authority (H), role-mode transitions, and the
separation between supervisor-mode and role-mode mutations.
