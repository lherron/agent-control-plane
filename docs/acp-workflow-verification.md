# ACP Workflow Verification

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
