# Runbook — Support escalation waiting on customer response

> ## ⚠️ Real-agent execution required
>
> This scenario MUST be executed by real agent runtimes, not by an operator
> issuing CLI commands with `--as agent:X`. Operator-CLI walks validate the CLI
> surface but are NOT acceptance evidence.
>
> ### Agent assignments
>
> | Steps | Agent | Role |
> | --- | --- | --- |
> | 1, 6–7 | **Supervisor agent (rex)** | Publishes workflow, creates task + supervisor run, applies `wait_for_customer`, satisfies customer obligation |
> | 2–5, 8–9 | **Participant agent (larry)** | Support agent — attaches triage summary, applies `start_triage`, records customer outreach, applies `reach_out`, applies `resume_resolution`, resolves |
>
> See [`scenarios/flow-presets/README.md`](../README.md) for the cross-cutting
> real-agent execution policy.

End-to-end walkthrough for `support_escalation@1` (see `workflow.json`). This is a non-code workflow that exercises the kernel's blocking-obligation pattern: the task sits in `status=waiting` until the customer's reply lands and the obligation is satisfied.

> **Note on CLI mapping.** Legacy task commands such as `task evidence add`,
> `task transitions`, and phase-based mutation were removed as breaking
> changes. This scenario is validated through the workflow kernel scenario
> conformance test, which loads `workflow.json` and executes `scenario.json`.

## Setup

```bash
export ACTOR_AGENT=morgan
export PROJECT=agent-spaces
export TASK_ID=T-SUPP-DEMO
```

Publish the workflow definition into the kernel before driving the scenario. A minimal harness (e.g. `bun --eval` or a small script under `tests/conformance`) loads `workflow.json` via:

```ts
import workflowJson from './scenarios/flow-presets/support-escalation-customer-response/workflow.json'
kernel.publishWorkflowDefinition(workflowJson as WorkflowDefinition)
```

## 1. Create the task

```text
[kernel] kernel.createTask({
  taskId: 'T-SUPP-DEMO',
  projectId: 'agent-spaces',
  workflow: { id: 'support_escalation', version: 1 },
  goal: 'Customer cannot complete checkout when paying via stored card on file.',
  risk: 'low',
  roleBindings: { support_agent: { kind: 'human', id: 'morgan' } },
  idempotencyKey: 'scenario:support:create:v1',
})
```

Expected: `state = { status: 'open', phase: 'triage' }`.

## 2. Attach the triage summary

```text
[kernel] kernel.applyTransition with inlineEvidence: [{ kind: 'triage_summary', ref: 'doc:triage-zd-198432', summary: '...' }]
```

The scenario conformance test carries this evidence forward and submits it
with the next legal workflow mutation.

## 3. Apply `start_triage`

```text
[kernel] kernel.applyTransition({
  taskId: 'T-SUPP-DEMO',
  transitionId: 'start_triage',
  actor: { kind: 'human', id: 'morgan' },
  role: 'support_agent',
  expectedTaskVersion: 0,
  idempotencyKey: 'scenario:support:start_triage:v0',
})
```

Expected: `state = { status: 'active', phase: 'triage' }`.

## 4. Record the customer outreach

Attach evidence `customer_outreach_record` (kernel `attachEvidence` or inline on the next transition).

## 5. Apply `reach_out`

```text
[kernel] kernel.applyTransition({ transitionId: 'reach_out', role: 'support_agent', ... })
```

Expected: `state = { status: 'active', phase: 'contact_customer' }`.

## 6. Apply `wait_for_customer` — workflow now blocks

```text
[kernel] kernel.applyTransition({ transitionId: 'wait_for_customer', role: 'support_agent', ... })
```

Expected:
- `state = { status: 'waiting', phase: 'awaiting_customer' }`
- effect intents emitted: `create_obligation(customer_response_pending, blocking=true, owner=customer_proxy)` and `start_timer(PT72H)`.
- `kernel.listObligations(taskId)` lists one open blocking obligation.

## 7. Customer replies — supervisor satisfies the obligation

```text
[kernel] kernel.submitControlAction({
  taskId: 'T-SUPP-DEMO',
  supervisorRunId: 'sup-run-001',
  capabilities: { satisfyObligations: true },
  action: {
    type: 'satisfy_obligation',
    obligationId: '<id from listObligations>',
    evidence: [{
      kind: 'customer_response',
      ref: 'email:zd-198432:2',
      summary: 'Customer supplied masked token tok_***4242 and timestamps.'
    }],
  },
  idempotencyKey: 'scenario:support:satisfy:v1',
})
```

The kernel marks the obligation as `satisfied`. The task version increments but `state.status` stays `waiting` because a defined resume transition (`resume_resolution`) covers `from: waiting/awaiting_customer` — the kernel does not auto-resume.

## 8. Apply `resume_resolution`

```text
[kernel] kernel.applyTransition({ transitionId: 'resume_resolution', role: 'support_agent', ... })
```

Expected: `state = { status: 'active', phase: 'resolution' }`. The transition's `requires` (`obligation_satisfied: customer_response_pending` and `evidence: customer_response`) are both satisfied.

## 9. Attach `resolution_note` + apply `resolve`

```text
[kernel] kernel.applyTransition({
  transitionId: 'resolve',
  role: 'support_agent',
  inlineEvidence: [{ kind: 'resolution_note', ref: 'doc:resolution-zd-198432', summary: '...' }],
  ...
})
```

Expected: `state = { status: 'closed', outcome: 'resolved' }`.

## Inspect

```text
[kernel] kernel.getTask('T-SUPP-DEMO')
[kernel] kernel.listEvents('T-SUPP-DEMO')
[kernel] kernel.listObligations('T-SUPP-DEMO')
[kernel] kernel.listEffectIntents('T-SUPP-DEMO')
```

## Negative checks

- Skip step 07: applying `resume_resolution` rejects with `obligation_not_satisfied` and `missing_evidence` for `customer_response`.
- After step 06, attempting `resolve` directly rejects with `state_mismatch` (the only legal outbound transitions from `waiting/awaiting_customer` are `resume_resolution` and `abandon_no_reply`).
- After step 06, applying `abandon_no_reply` (supervisor bypass) closes with `outcome=abandoned` — this is the timer-elapsed branch.
