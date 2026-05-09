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
| `bun test tests/conformance/acp-workflow` | Passed: 14 tests, 71 assertions. |
| `bun run --filter acp-core typecheck` | Passed. |
| `bun run --filter acp-core build` | Passed. |
| `bun run --filter acp-core test` | Passed: 48 tests, 151 assertions. |
| `bun run lint` | Passed with one existing warning in `packages/gateway-discord/src/session-events-manager.ts` for cognitive complexity. |
| `bun run typecheck` | Passed across the workspace. |
| `bun run build` | Passed across the workspace. |
| `bun run test` | Passed. The workflow conformance suite ran first and passed with 14 tests/71 assertions; the final integration package reported 159 tests/489 assertions with no failures. |

## Model Boundary

The conformance kernel treats workflow state as the durable source of truth:
tasks pin `workflow.id`, `workflow.version`, and `workflow.hash`; state is modeled
as `open`, `active`, `waiting`, or `closed` plus phase/outcome; mutations use
`transitionId` and idempotency keys.

The existing ACP task/preset API still contains compatibility fields such as
`workflowPreset`, `presetVersion`, `lifecycleState`, and `toPhase` in CLI, server,
wrkq, and projection code. Those paths are not migrated by this patch. The
conformance suite asserts that newly created workflow-kernel tasks do not persist
the legacy preset fields as the kernel's workflow truth.
