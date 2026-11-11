# Flow presets — end-to-end scenarios

> **Kernel-only.** These scenarios run against the in-memory `acp-core`
> workflow kernel. The live ACP server no longer publishes workflows, creates
> kernel tasks or runs supervisors (W6a, T-01936); its `/v1/tasks/:taskId`
> routes are wrkf facades. The scenario conformance test below is the only
> checked command.

End-to-end scenarios for the ACP workflow kernel
(`packages/acp-core/src/workflow/index.ts`). Each scenario folder is
self-contained:

- `workflow.json` — `WorkflowDefinition` fixture (same shape used by
  `tests/conformance/acp-workflow/fixtures/workflows.ts`). Loadable directly
  by `kernel.publishWorkflowDefinition(...)`.
- `scenario.json` — machine-readable plan: actors, role bindings, task seed,
  ordered steps (with `kernel.op`/`controlAction`/`evidence`/`transitionId`),
  expected state-after, expected effect intents, and negative checks.
- `docs/runbooks/flow-presets/<folder>.md` — human-readable walkthrough showing the canonical kernel
  calls, for the three kernel-checked scenarios in the table below. The checked
  command is the scenario conformance test listed below.

The `evidence-provenance-attach/`, `obligation-waive-cancel-lifecycle/` and
`participant-supervisor-evidence-authority/` folders are `manualOnly`: the test
skips them because they were walked through ACP CLI surfaces that W6a removed.
Their runbooks are preserved as attachments on T-01936.

## Scenarios

| Folder | Workflow id @ version | Kind | Highlights |
| --- | --- | --- | --- |
| `hotfix-implementer-tester/` | `hotfix_fastlane@1` | `code_change` | Implementer/tester SoD, `declare_handoff` + `wake_role_session` effects on red→green at risk≥medium. |
| `support-escalation-customer-response/` | `support_escalation@1` | `support` | Non-code. Blocking obligation `customer_response_pending` parks the task in `waiting/awaiting_customer` until the customer replies. 72h timer effect. |
| `procurement-legal-approval/` | `procurement_legal_approval@1` | `approval` | Non-code. Two cascading blocking obligations (`vendor_response_pending` then `legal_review_pending`) and a three-way SoD enforced by explicit `sod` requirements on `resume_legal_review`, `complete_legal_review` and `approve`/`reject` (legal_reviewer ≠ requester, procurement_lead; procurement_lead ≠ requester, legal_reviewer). |

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
valid scenario validation commands. The ACP CLI no longer has `task create`,
`supervise`, `workflow publish` or `workflow action`; its remaining `task`
commands call wrkf-backed routes. The scenario artifacts are validated directly
against the in-memory workflow kernel.

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

## Cleanup rule

Any smoke, e2e, or manual recipe that creates a real wrkq/ACP task must close
that task before the run ends. Prefer the workflow's terminal transition
(`close_success`, `approve`, `resolve`, `reject`, `abandon_no_reply`, etc.).
For rejection-only fixture tasks where no terminal workflow step is part of the
assertion, the harness or operator must mark the throwaway wrkq task
`completed` or `cancelled` during cleanup and record that cleanup in the task
comments.
