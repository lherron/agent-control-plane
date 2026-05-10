# Runbook — Participant runtime + supervisor evidence-backed authority

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
> | 1, 7, 10–12 | **Supervisor agent (rex)** | Publishes workflow, starts supervisor run, applies supervisor transitions, pauses/unpauses supervision |
> | 2–6, 14 | **Participant agent (larry)** | Implementer — attaches plan, starts, launches run, attaches evidence, completes run, closes task |
> | 8–9, 13 | **Participant agent (curly)** | Tester — launches run, attaches verification report, applies verify transition |
>
> See [`scenarios/flow-presets/README.md`](../README.md) for the cross-cutting
> real-agent execution policy.

End-to-end walkthrough for `participant_supervisor_demo@1` (see `workflow.json`
and `scenario.json`). Exercises ACP Checkpoints G (participant runtime
create/resume) and H (supervisor `AttachEvidence`, `ApplyTransition`,
`PauseSupervision`, `UnpauseSupervision` control actions with
capability-and-provenance authorization).

## What this scenario proves

1. `POST /v1/workflow-participant-runs` and `acp task run` are the
   user-direct path to launching a participant run. The kernel rejects any
   request whose body actor does not match the persisted role binding
   (`role_not_bound`) — no role self-claim via the user-direct surface.
2. Participant runs carry a lifecycle status
   (`launched|running|completed|failed|cancelled`) and emit
   `participant_run.launched` / `participant_run.completed` events.
3. Evidence attached during a participant run records `participantRunId`
   provenance — that's the durable link supervisor `ApplyTransition` will
   verify.
4. Supervisor `ApplyTransition` is **administrative authority backed by
   participant evidence**, not a role bypass. The kernel:
   - requires explicit `evidenceRefs`,
   - verifies each evidence record belongs to the task,
   - verifies each evidence record was attached by a participant run
     (not by the supervisor itself),
   - verifies the participant run's role appears in the transition's `by[]`,
   - verifies the participant run's actor matches the current role binding,
   - records `authority='supervisor_from_participant_evidence'` on the
     `transition.applied` event payload alongside `supervisorRunId`.
5. `PauseSupervision` and `UnpauseSupervision` produce real state changes
   on the persisted supervisor run record, gating further control actions
   with `supervisor_paused`.
6. `submitControlAction` authorization derives capabilities from the
   persisted supervisor run record, NOT from the request body — request-body
   capability claims are ignored.
7. Role-mode transitions (here: `verify`) and supervisor-mode transitions
   (here: `implement_fix` via ApplyTransition) coexist on the same task.

## Manual execution

```bash
# 1. Publish workflow + start supervisor run
acp workflow publish ./scenarios/flow-presets/participant-supervisor-evidence-authority/workflow.json

acp supervise \
  --workflow participant_supervisor_demo@1 \
  --project agent-spaces \
  --task-id T-PARTICIPANT-SUPERVISOR-DEMO \
  --goal "Drive a code-change task via participant runs and supervisor authority" \
  --risk medium \
  --bind implementer=agent:larry \
  --bind tester=agent:curly \
  --supervisor agent:rex \
  --autonomy managed \
  --supervisor-capability launchRuns,attachEvidence,applySupervisorTransitions,pauseSupervision \
  --idempotency-key scenario:participant-supervisor:create:v1
# capture <SUPERVISOR_RUN_ID> from output

# 2. Implementer attaches plan_record (standalone evidence attach as role-bound actor)
acp task evidence add \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --kind plan_record --ref doc:plan-v1 --summary "Plan: guard nil order id" \
  --as agent:larry --role implementer \
  --idempotency-key scenario:participant-supervisor:attach-plan:v1

# 3. Implementer starts (open/plan -> active/plan)
acp task transition \
  --task T-PARTICIPANT-SUPERVISOR-DEMO --transition start \
  --as agent:larry --role implementer \
  --idempotency-key scenario:participant-supervisor:start:v1

# 4. User-direct participant launch for implementer
acp task run \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --role implementer --agent larry \
  --idempotency-key scenario:participant-supervisor:launch-implementer:v1
# capture <IMPLEMENTER_RUN_ID>

# 5. Implementer attaches commit_ref + regression_test with run provenance
acp task evidence add \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --kind commit_ref --ref git:agent-spaces@deadbee --summary "fix: guard nil order id" \
  --as agent:larry --from-run <IMPLEMENTER_RUN_ID> \
  --idempotency-key scenario:participant-supervisor:commit:v1

acp task evidence add \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --kind regression_test --ref test:integration/orders.checkout.repro \
  --summary "Regression test now passing" \
  --as agent:larry --from-run <IMPLEMENTER_RUN_ID> \
  --idempotency-key scenario:participant-supervisor:regression:v1

# 6. Complete implementer participant run
acp task run-complete \
  --run <IMPLEMENTER_RUN_ID> --outcome success \
  --evidence-ref <evd_commit_ref> --evidence-ref <evd_regression_test> \
  --idempotency-key scenario:participant-supervisor:implementer-complete:v1

# 7. SUPERVISOR APPLY-TRANSITION (the headline of this scenario)
acp workflow action \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"apply_transition","transitionId":"implement_fix","evidenceRefs":["<evd_commit_ref>","<evd_regression_test>"]}' \
  --idempotency-key scenario:participant-supervisor:supv-apply-implement:v1
# verify event payload: { authority: "supervisor_from_participant_evidence",
#                          supervisorRunId: "<SUPERVISOR_RUN_ID>",
#                          evidenceRefs: [...] }

# 8. User-direct participant launch for tester
acp task run \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --role tester --agent curly \
  --idempotency-key scenario:participant-supervisor:launch-tester:v1

# 9. Tester attaches verification_report with run provenance
acp task evidence add \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --kind verification_report --ref report:qa-2026-05-09 --summary "Verification clean" \
  --as agent:curly --from-run <TESTER_RUN_ID> \
  --idempotency-key scenario:participant-supervisor:tester-evidence:v1

# 10. Pause supervision
acp workflow action \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"pause_supervision","reason":"Manual reviewer break"}' \
  --idempotency-key scenario:participant-supervisor:pause:v1

# 11. EXPECTED REJECTION: paused control action
acp workflow action \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"attach_evidence","evidence":[{"kind":"verification_report","ref":"report:other","summary":"x"}]}' \
  --idempotency-key scenario:participant-supervisor:paused-attach:v1
# expect: rejection_code=supervisor_paused

# 12. Unpause
acp workflow action \
  --task T-PARTICIPANT-SUPERVISOR-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"unpause_supervision"}' \
  --idempotency-key scenario:participant-supervisor:unpause:v1

# 13. Tester applies verify (role-mode, NOT supervisor-mode)
acp task transition \
  --task T-PARTICIPANT-SUPERVISOR-DEMO --transition verify \
  --as agent:curly --role tester \
  --idempotency-key scenario:participant-supervisor:verify:v1

# 14. Implementer closes
acp task transition \
  --task T-PARTICIPANT-SUPERVISOR-DEMO --transition close_success \
  --as agent:larry --role implementer \
  --idempotency-key scenario:participant-supervisor:close:v1
```

## Negative checks (run on fresh fixture tasks where appropriate)

- `user-launch-with-unbound-role-rejected` — `acp task run --role tester` on
  a task without tester binding. Expect `role_not_bound`.
- `user-launch-actor-mismatch-rejected` — `acp task run --role implementer
  --agent rex` when implementer=larry. Expect `role_not_bound`.
- `supervisor-apply-transition-with-supervisor-only-evidence-rejected` — all
  required evidence attached by supervisor, none by participant run.
  Supervisor ApplyTransition rejects with `authority_not_granted`.
- `supervisor-apply-transition-without-evidenceRefs-rejected` — call
  ApplyTransition action without `evidenceRefs`. Expect `missing_evidence`.
- `supervisor-without-applySupervisorTransitions-cap-rejected` — supervisor
  binding lacks the capability. ApplyTransition rejects with
  `capability_not_granted`.
- `request-body-capability-override-ignored` — request body claims caps the
  persisted supervisor run lacks. Reject `capability_not_granted` (per the
  cody-mandated authorization hardening: capabilities derive from the
  persisted run record).
- `pause-without-pauseSupervision-cap-rejected` — pause attempted without
  the cap. Expect `capability_not_granted`.

## Validation

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
bun test tests/conformance/acp-workflow/participant-runtime.conformance.test.ts
bun test tests/conformance/acp-workflow/supervisor-actions.conformance.test.ts
bun test packages/acp-core/src/__tests__/workflow-participant-runtime.test.ts
bun test packages/acp-server/test/workflow-participant-runs.test.ts
bun test packages/acp-server/test/workflow-supervisor-actions.test.ts
bun test packages/acp-cli/test/commands/task-run.test.ts
bun test packages/acp-cli/test/commands/task-run-complete.test.ts
```
