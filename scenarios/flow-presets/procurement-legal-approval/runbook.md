# Runbook — Procurement & legal approval (vendor wait + legal review)

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
> | 1, 4–6 | **Supervisor agent (rex)** | Publishes workflow, creates task + supervisor run, routes to vendor, waits for vendor, satisfies vendor obligation |
> | 2–3 | **Participant agent (larry)** | Requester — attaches `request_packet`, applies `submit_request` |
> | 7–8 | **Participant agent (curly)** | Legal reviewer — applies `resume_legal_review`, attaches `legal_review`, satisfies legal obligation |
> | 9–11 | **Participant agent (cody)** | Procurement lead — applies `complete_legal_review`, attaches `approval_record`, applies `approve` |
>
> See [`scenarios/flow-presets/README.md`](../README.md) for the cross-cutting
> real-agent execution policy.

End-to-end walkthrough for `procurement_legal_approval@1` (see `workflow.json`). Non-code workflow with two cascading blocking obligations:

1. `vendor_response_pending` — the workflow waits in `awaiting_vendor` until the vendor's response packet lands.
2. `legal_review_pending` — opened on resume; legal must complete its review before procurement can finalize.

> **Note on CLI mapping.** Legacy task commands and phase-based task mutation
> were removed as breaking changes. This runbook is kernel-driven and is
> validated by `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`,
> which loads `workflow.json` and executes `scenario.json`.

## Setup

```bash
export PROJECT=agent-spaces
export TASK_ID=T-PROC-DEMO
```

Publish the workflow definition:

```ts
import workflowJson from './scenarios/flow-presets/procurement-legal-approval/workflow.json'
kernel.publishWorkflowDefinition(workflowJson as WorkflowDefinition)
```

## 1. Create the task

```text
[kernel] kernel.createTask({
  taskId: 'T-PROC-DEMO',
  projectId: 'agent-spaces',
  workflow: { id: 'procurement_legal_approval', version: 1 },
  goal: 'Procure 50 seat licenses for VendorX analytics; needs legal sign-off on revised DPA.',
  risk: 'medium',
  roleBindings: {
    requester:        { kind: 'human', id: 'alex' },
    procurement_lead: { kind: 'human', id: 'pat' },
    legal_reviewer:   { kind: 'human', id: 'robin' },
  },
  idempotencyKey: 'scenario:procurement:create:v1',
})
```

Expected: `state = { status: 'open', phase: 'intake' }`.

## 2-3. Submit request

Attach `request_packet`, then apply `submit_request`. After:

`state = { status: 'active', phase: 'intake' }`.

## 4. Route to vendor outreach

```text
[kernel] kernel.applyTransition({
  transitionId: 'route_to_vendor',
  role: 'procurement_lead',
  actor: { kind: 'human', id: 'pat' },
  ...
})
```

`state = { status: 'active', phase: 'vendor_outreach' }`.

## 5. Wait for vendor

```text
[kernel] kernel.applyTransition({ transitionId: 'wait_for_vendor', role: 'procurement_lead', ... })
```

`state = { status: 'waiting', phase: 'awaiting_vendor' }`. Effect intents emitted:
- `create_obligation(vendor_response_pending, blocking=true, owner=vendor_proxy)`
- `start_timer(P5D)`

## 6. Vendor responds — supervisor satisfies the obligation

```text
[kernel] kernel.submitControlAction({
  taskId: 'T-PROC-DEMO',
  supervisorRunId: 'sup-run-001',
  capabilities: { satisfyObligations: true },
  action: {
    type: 'satisfy_obligation',
    obligationId: '<id of vendor_response_pending>',
    evidence: [{
      kind: 'vendor_response',
      ref: 'doc:vendorx-response-2026-05-08',
      summary: 'VendorX returned signed DPA v3 with redlines on §7.2; quote confirmed.',
    }],
  },
  idempotencyKey: 'scenario:procurement:satisfy-vendor:v1',
})
```

State remains `waiting/awaiting_vendor` until the resume transition is applied.

## 7. Resume into legal review

```text
[kernel] kernel.applyTransition({
  transitionId: 'resume_legal_review',
  role: 'legal_reviewer',
  actor: { kind: 'human', id: 'robin' },
  ...
})
```

`state = { status: 'active', phase: 'legal_review' }`. Effect: a fresh blocking obligation `legal_review_pending` opens, owned by `legal_reviewer`.

## 8. Legal completes the review

Attach `legal_review` evidence (kernel `attachEvidence` or inline on the satisfy step), then satisfy `legal_review_pending`:

```text
[kernel] kernel.submitControlAction({
  action: {
    type: 'satisfy_obligation',
    obligationId: '<id of legal_review_pending>',
    evidence: [{
      kind: 'legal_review',
      ref: 'doc:legal-review-vendorx-2026-05-09',
      summary: 'DPA v3 redlines accepted; standard MSA clauses unchanged. Approve.',
    }],
  },
  ...
})
```

## 9. Complete legal review

```text
[kernel] kernel.applyTransition({
  transitionId: 'complete_legal_review',
  role: 'procurement_lead',
  ...
})
```

`state = { status: 'active', phase: 'final_approval' }`. Requires `obligation_satisfied: legal_review_pending` + `evidence: legal_review`.

## 10-11. Attach approval record + approve

```text
[kernel] kernel.applyTransition({
  transitionId: 'approve',
  role: 'procurement_lead',
  actor: { kind: 'human', id: 'pat' },
  inlineEvidence: [{
    kind: 'approval_record',
    ref: 'doc:approval-vendorx-2026-05-09',
    summary: 'Approved: 50 seats VendorX analytics, $84k/yr, DPA v3.',
  }],
  ...
})
```

`state = { status: 'closed', outcome: 'approved' }`. SoD requires the acting actor to differ from the `requester` binding.

## Inspect

```text
[kernel] kernel.getTask('T-PROC-DEMO')
[kernel] kernel.listEvents('T-PROC-DEMO')
[kernel] kernel.listObligations('T-PROC-DEMO')
[kernel] kernel.listEffectIntents('T-PROC-DEMO')
```

## Negative checks

SoD is enforced by explicit `sod` requirements on `resume_legal_review` (`legal_reviewer` `notSameAs` `[requester, procurement_lead]`) and on `approve` / `reject` (`procurement_lead` `notSameAs` `[requester, legal_reviewer]`). `RoleSpec.mustDifferFrom` is metadata only in the current kernel and is not auto-enforced — the explicit `sod` requirements are what reject these cases.

- **sod_violation — procurement_lead == requester:** Create a separate task binding `requester` AND `procurement_lead` to the same actor (e.g. both `alex`). After legal review is satisfied, `complete_legal_review` rejects with `sod_violation`, preventing `final_approval`.
- **sod_violation — procurement_lead == legal_reviewer:** Create a separate task binding `procurement_lead` AND `legal_reviewer` to the same actor. After the vendor obligation is satisfied, `resume_legal_review` rejects with `sod_violation`, preventing `final_approval`.
- **sod_violation — legal_reviewer == requester:** Create a separate task binding `requester` AND `legal_reviewer` to the same actor. After the vendor obligation is satisfied, apply `resume_legal_review`. Rejected with `sod_violation`.
- **sod_violation — legal_reviewer == procurement_lead:** Create a separate task binding `procurement_lead` AND `legal_reviewer` to the same actor. Apply `resume_legal_review` after the vendor obligation is satisfied. Rejected with `sod_violation`.
- **role_not_bound:** In the happy-path task (different actors), attempt `approve` with actor=alex claiming role=procurement_lead. Rejected with `role_not_bound` — the binding check fires before SoD.
- **obligation_not_satisfied — vendor:** Skip step 6: step 7 `resume_legal_review` rejects with `obligation_not_satisfied` (vendor_response_pending is open and blocking).
- **obligation_not_satisfied — legal:** Skip step 8: step 9 `complete_legal_review` rejects with `obligation_not_satisfied` (legal_review_pending is open and blocking).

## Alternate branches

- From `active/final_approval`, applying `reject` (supervisorBypass) closes with `outcome=rejected` using the same evidence + SoD requirements as `approve`.
