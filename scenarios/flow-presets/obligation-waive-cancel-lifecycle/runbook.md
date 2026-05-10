# Runbook — Obligation waive vs cancel lifecycle

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
> | 1–2, 5, 9 | **Supervisor agent (rex)** | Publishes workflow, starts supervisor run, cancels obligation, attaches waiver evidence, waives obligation |
> | 3–4, 10 | **Participant agent (larry)** | Author — attaches draft, submits, approves |
> | 6–8 | **Participant agent (curly)** | Reviewer — attaches review notes, advances to audit |
>
> See [`scenarios/flow-presets/README.md`](../README.md) for the cross-cutting
> real-agent execution policy.

End-to-end walkthrough for `obligation_waive_cancel_demo@1` (see `workflow.json`
and `scenario.json`). Exercises ACP Checkpoint E2: the widened
`ObligationRecord.status` enum (`open|satisfied|waived|cancelled|expired`),
the new waive and cancel APIs, and the honoring of `waiverRefs` on transitions.

## What this scenario proves

1. `ObligationRecord.status` widens beyond `open|satisfied|cancelled` to
   include `waived` (and reserves `expired` for future timer-driven flows).
2. `waive_obligation` records both an `obligation.waived` state change AND a
   waiver record that the kernel matches against
   `Requirement{type:'waiver', waiverKind:...}` on subsequent transitions.
3. `cancel_obligation` is a supersession path — it does NOT satisfy waiver
   requirements. This distinction is enforced by the kernel.
4. `acp task obligation waive` and `acp task obligation cancel` round-trip
   the lifecycle through HTTP endpoints
   (`POST /v1/tasks/:taskId/obligations/:obligationId/waive` and
   `…/cancel`).
5. Both mutations are idempotent under the standard
   `idempotencyKey + payload fingerprint` rule.
6. `expired` status enum value is reserved but no public CLI/API exposes it
   in this batch — only the internal kernel `expireObligation` method.

## Manual execution

```bash
# 1. Publish workflow
acp workflow publish ./scenarios/flow-presets/obligation-waive-cancel-lifecycle/workflow.json

# 2. Create task + start supervisor run (createObligations + satisfyObligations + createWaivers)
acp supervise \
  --workflow obligation_waive_cancel_demo@1 \
  --project agent-spaces \
  --task-id T-OBLIGATION-LIFECYCLE-DEMO \
  --goal "Drive a draft through review and audit" \
  --risk medium \
  --bind author=agent:larry \
  --bind reviewer=agent:curly \
  --supervisor agent:rex \
  --autonomy managed \
  --supervisor-capability createObligations,satisfyObligations,createWaivers \
  --idempotency-key scenario:obligation-lifecycle:create:v1
# capture <SUPERVISOR_RUN_ID> from output

# 3. Author attaches draft_package
acp task evidence add \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --kind draft_package --ref doc:draft-v1 --summary "Initial draft" \
  --as agent:larry --role author \
  --idempotency-key scenario:obligation-lifecycle:draft:v1

# 4. Author submits → fires create_obligation effects (reviewer_signoff_pending + auto_cleanup_pending)
acp task transition \
  --task T-OBLIGATION-LIFECYCLE-DEMO --transition submit \
  --as agent:larry --role author \
  --idempotency-key scenario:obligation-lifecycle:submit:v1

# 5. Cancel auto_cleanup_pending — status should become 'cancelled'
acp task obligation cancel \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --obligation <OBL_AUTO_CLEANUP_ID> \
  --reason "Superseded by direct cleanup pipeline run." \
  --actor rex \
  --idempotency-key scenario:obligation-lifecycle:cancel-cleanup:v1

# 6. Reviewer attaches review_notes + supervisor satisfies reviewer_signoff_pending
acp task evidence add \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --kind review_notes --ref doc:review-notes-v1 --summary "Reviewer accepted" \
  --as agent:curly --role reviewer \
  --idempotency-key scenario:obligation-lifecycle:review-notes:v1

acp workflow action \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"satisfy_obligation","obligationId":"<OBL_REVIEWER_SIGNOFF_ID>","evidenceRefs":["<evd_review_notes>"]}' \
  --idempotency-key scenario:obligation-lifecycle:satisfy-reviewer:v1

# 7. Reviewer advances to audit (creates audit_signoff_pending)
acp task evidence add \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --kind review_completion_record --ref doc:review-completion-v1 \
  --summary "Review concluded" \
  --as agent:curly --role reviewer \
  --idempotency-key scenario:obligation-lifecycle:review-completion:v1

acp task transition \
  --task T-OBLIGATION-LIFECYCLE-DEMO --transition advance_to_audit \
  --as agent:curly --role reviewer \
  --idempotency-key scenario:obligation-lifecycle:advance:v1

# 8. EXPECTED REJECTION: approve without waiver
acp task transition \
  --task T-OBLIGATION-LIFECYCLE-DEMO --transition approve \
  --as agent:larry --role author \
  --idempotency-key scenario:obligation-lifecycle:approve-fail:v1
# expect: rejection_code=open_blocking_obligation (blocking obligation still open)

# 9. Supervisor attaches audit_waiver + waives audit_signoff_pending
acp task evidence add \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --kind audit_waiver --ref doc:audit-waiver-2026-05-09 \
  --summary "Audit waived under §4.2" \
  --as agent:rex --supervisor-run <SUPERVISOR_RUN_ID> \
  --idempotency-key scenario:obligation-lifecycle:audit-waiver-evidence:v1

acp task obligation waive \
  --task T-OBLIGATION-LIFECYCLE-DEMO \
  --obligation <OBL_AUDIT_SIGNOFF_ID> \
  --reason "Low-risk template change covered by §4.2; prior audit valid." \
  --evidence-ref <evd_audit_waiver> \
  --actor rex \
  --idempotency-key scenario:obligation-lifecycle:waive-audit:v1

# 10. Approve succeeds — waiver record matches the transition's Requirement{type:'waiver'}
#     --waiver-ref passes the waived obligation ID so the kernel can verify the waiver record.
acp task transition \
  --task T-OBLIGATION-LIFECYCLE-DEMO --transition approve \
  --as agent:larry --role author \
  --waiver-ref <OBL_AUDIT_SIGNOFF_ID> \
  --idempotency-key scenario:obligation-lifecycle:approve-success:v1
```

## Negative checks

- `cancel-does-not-satisfy-waiver` — re-run with cancel_obligation in step 9
  instead of waive_obligation. Step 10 should fail with `waiver_required`.
- `waive-without-capability-rejected` — recreate supervisor binding without
  `createWaivers`. Step 9 fails with `capability_not_granted`.
- `cancel-without-reason-rejected` — `acp task obligation cancel` without
  `--reason` fails with `invalid_evidence` (cancel requires reason).
- `waive-idempotency-conflict` — replay step 9 with a different reason,
  same idempotency key. Expect `idempotency_conflict`.
- `expired-status-reserved-not-cli-exposed` — confirm
  `acp task obligation expire` does not exist; the `expired` terminal is
  reserved for the internal kernel `expireObligation` only.

## Validation

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
bun test tests/conformance/acp-workflow/obligation-lifecycle.conformance.test.ts
bun test packages/acp-core/src/__tests__/workflow-obligation-lifecycle.test.ts
bun test packages/acp-server/test/workflow-task-obligations.test.ts
bun test packages/acp-cli/test/commands/task-obligation-waive-cancel.test.ts
```
