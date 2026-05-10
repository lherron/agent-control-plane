# ACP Workflow Conformance Suite

This suite encodes the workflow-kernel invariants from
`acp-final-workflow-ecosystem-proposal.md` as executable tests. It does not
copy the proposal into assertions; each group below maps one invariant family
to concrete coverage.

## Invariant Map

| Area | Invariants | Coverage |
| --- | --- | --- |
| WorkflowDefinition publishing/pinning | Durable tasks pin `{ id, version, hash }`; `latest` is creation-time only; fixtures are immutable once published. | `workflow-kernel.conformance.test.ts`: task creation, fixture immutability |
| Task state model | Durable workflow truth is `state: { status, phase?, outcome? }`; `completed`, `cancelled`, and `failed` are outcomes, not statuses. | task creation and invalid state tests |
| Transition kernel semantics | Mutations use `transitionId`; invalid from-state is rejected; transition commands expose exact IDs. | transition validation and context golden tests |
| Evidence | Required evidence is typed and checked; inline evidence can be attached atomically with a transition. | missing evidence and happy-path code scenario |
| Obligations/waiting | Waiting is caused by open blocking obligations; satisfying obligations enables defined resume transitions. | approval scenario and participant blocked context |
| Role authorization and SoD | Actors cannot self-assert unbound roles; required SoD compares actor refs, not role names. | role binding and SoD tests |
| Idempotency/version/context hash | Mutating commands require idempotency keys; same key and payload replays; same key with different payload conflicts; version/context mismatches reject. | idempotency and conflict tests |
| EffectIntent outbox | Effects are durable intents emitted with workflow events, not immediate side effects. | handoff/wake and child task effect tests |
| ParticipantContext | Context is structured JSON with legal command templates and unavailable transition reasons. | participant golden tests |
| SupervisorContext | Context includes actions, obligations, evidence, participant runs, anomalies, suggestions, and command templates. | supervisor golden tests |
| WorkflowControlAction | Supervisor actions are checked, capability-gated, and applied one action at a time. | control action tests |
| WorkflowPatchProposal | Anomaly-driven proposals do not mutate the active WorkflowDefinition. | patch proposal test |

## Fixtures

Workflow fixtures live in `fixtures/workflows.ts`:

- `basic@1`: minimal durable generic task workflow.
- `code_defect_fastlane@1`: code workflow with implementer/tester SoD,
  evidence, handoff/wake effects, and success closure.
- `external_dependency_approval@1`: non-code approval workflow with blocking
  obligations and a child-task effect.

## Running

```bash
bun test tests/conformance/acp-workflow
```

Golden JSON lives under `golden/`. Update golden files only when the intended
agent-facing contract changes.
