# Flow presets — end-to-end scenarios

> ## ⚠️ Real-agent execution required
>
> Every scenario walk **MUST** be driven by real agent runtimes — a supervisor
> agent (typically rex) and per-role participant agents (typically larry, curly,
> etc.) — each in their own `hrc` session.
>
> **Operator-issued CLI walks with `--as agent:X` are NOT acceptance evidence.**
> They validate the CLI surface but not real agent participation. The system is
> not considered validated unless real agents drive the commands.
>
> ### Reference pattern
>
> 1. The **supervisor agent** is dispatched first via `hrcchat dm` to a
>    task-scoped session (e.g. `rex@agent-spaces:T-XXX`).
> 2. The supervisor reads the runbook and drives all supervisor-side commands
>    (workflow publish, supervise, supervisor actions, transitions it owns).
> 3. For each role-bound participant segment, the supervisor dispatches the
>    matching participant agent to a per-role lane (e.g.
>    `larry@agent-spaces:T-XXX/collector`,
>    `curly@agent-spaces:T-XXX/implementer`) via `hrcchat dm`.
> 4. Each participant agent executes its commands in its own runtime and replies
>    with run/evidence IDs.
> 5. The supervisor confirms via `acp task show` and proceeds.
>
> See also: [`docs/acp-supervisor-playbook.md`](../docs/acp-supervisor-playbook.md)
> for the canonical supervisor dispatch protocol.

Three end-to-end scenarios for the new ACP workflow kernel
(`packages/acp-core/src/workflow/index.ts`). Each scenario folder is
self-contained:

- `workflow.json` — `WorkflowDefinition` fixture (same shape used by
  `tests/conformance/acp-workflow/fixtures/workflows.ts`). Loadable directly
  by `kernel.publishWorkflowDefinition(...)`.
- `scenario.json` — machine-readable plan: actors, role bindings, task seed,
  ordered steps (with `kernel.op`/`controlAction`/`evidence`/`transitionId`),
  expected state-after, expected effect intents, and negative checks.
- `runbook.md` — human-readable walkthrough showing the canonical kernel
  calls. The checked command for all scenarios is the scenario conformance
  test listed below.

## Scenarios

| Folder | Workflow id @ version | Kind | Highlights |
| --- | --- | --- | --- |
| `hotfix-implementer-tester/` | `hotfix_fastlane@1` | `code_change` | Implementer/tester SoD, `declare_handoff` + `wake_role_session` effects on red→green at risk≥medium. |
| `support-escalation-customer-response/` | `support_escalation@1` | `support` | Non-code. Blocking obligation `customer_response_pending` parks the task in `waiting/awaiting_customer` until the customer replies. 72h timer effect. |
| `procurement-legal-approval/` | `procurement_legal_approval@1` | `approval` | Non-code. Two cascading blocking obligations (`vendor_response_pending` then `legal_review_pending`) and a three-way SoD enforced by explicit `sod` requirements on `resume_legal_review` and `approve`/`reject` (legal_reviewer ≠ requester, procurement_lead; procurement_lead ≠ requester, legal_reviewer). |

## Source-of-truth alignment

All three workflow definitions conform to the kernel types in
`packages/acp-core/src/workflow/index.ts`:

- `initial: { status, phase? }` with `status ∈ {open, active, waiting, closed}`
- `roles` with `binding: required | optional | autoBindOnFirstRun` and
  `mustDifferFrom`
- `evidenceKinds` and (for the non-code scenarios) `obligationKinds`
- `transitions` with `from`/`to` state patches, `by` role allow-list,
  `requires` (`evidence`, `sod`, `obligation_satisfied`) and `effects`
  (`declare_handoff`, `wake_role_session`, `create_obligation`,
  `start_timer`, `create_child_task`)

> **Note on SoD enforcement.** `RoleSpec.mustDifferFrom` is metadata in
> the current kernel and is not auto-enforced; only explicit `sod`
> requirements on transitions are checked. Scenarios that need SoD
> guarantees (procurement, hotfix verify) declare them explicitly on the
> relevant transitions.
- `supervisor.recovery` hints for missing-evidence / no-legal-transition
  remediation

The hotfix scenario is intentionally a near-clone of
`codeDefectFastlaneWorkflowV1` from `tests/conformance/acp-workflow/fixtures/workflows.ts`,
re-keyed under a new id so the conformance fixtures and the scenario
artifacts don't collide.

## CLI surface notes

Legacy task commands and route shapes were removed as breaking changes:
`task promote`, `task transitions`, and `toPhase` mutation examples are not
valid scenario validation commands. The current CLI surface is
workflow-oriented (`task create`, `task show`, `task transition`,
`task evidence add`, `task obligation waive/cancel`, `task run`,
`workflow action`, `workflow patch list/show`) and the scenario artifacts
are validated directly against the workflow kernel/runtime contract.

## Validating a scenario

Each `workflow.json` should round-trip through:

```ts
import workflowJson from './<folder>/workflow.json'
kernel.publishWorkflowDefinition(workflowJson as WorkflowDefinition)
```

without throwing. Then the steps in `scenario.json` should drive the task
from `initial` to the documented terminal `state`. The negative checks at
the bottom of each `scenario.json` are the rejection codes the kernel must
emit when their preconditions are violated.

Run all scenario artifacts with:

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```
