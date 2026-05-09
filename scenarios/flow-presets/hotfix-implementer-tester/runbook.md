# Runbook — Hotfix with implementer/tester SoD

End-to-end walkthrough for `hotfix_fastlane@1` (see `workflow.json`). The `acp task` CLI uses preset `code_defect_fastlane@1` which is the registered analogue of this workflow definition (same phase graph, same SoD rule). The conformance fixture in `tests/conformance/acp-workflow/fixtures/workflows.ts` is the canonical kernel-level reference.

## Setup

```bash
export ACTOR_IMPL=clod
export ACTOR_TEST=cody
export PROJECT=agent-spaces
```

## 1. Create the workflow task

```bash
acp --actor "$ACTOR_IMPL" task create \
  --preset code_defect_fastlane \
  --preset-version 1 \
  --project "$PROJECT" \
  --risk-class medium \
  --kind code_change \
  --role implementer:"$ACTOR_IMPL" \
  --role tester:"$ACTOR_TEST" \
  --json
```

Capture the returned `taskId` into `TASK_ID`. Expected: `phase=red`, `lifecycleState=open`.

## 2. Attach the failing reproduction

```bash
acp --actor "$ACTOR_IMPL" task evidence add \
  --task "$TASK_ID" \
  --kind failing_test \
  --ref test:integration/orders.checkout.repro \
  --producer-role implementer
```

## 3. Attach commit + regression evidence (post-fix)

```bash
acp --actor "$ACTOR_IMPL" task evidence add \
  --task "$TASK_ID" \
  --kind commit_ref \
  --ref git:agent-spaces@a1b2c3d \
  --producer-role implementer

acp --actor "$ACTOR_IMPL" task evidence add \
  --task "$TASK_ID" \
  --kind regression_test \
  --ref test:integration/orders.checkout.repro \
  --producer-role implementer
```

## 4. Transition red -> green (implementer only)

```bash
acp --actor "$ACTOR_IMPL" task transition \
  --task "$TASK_ID" \
  --to green \
  --actor-role implementer \
  --idempotency-key "scenario:hotfix:$TASK_ID:red-green"
```

In the new kernel this is `transitionId=implement_fix` and emits `declare_handoff` + `wake_role_session` effect intents because risk ≥ medium and tester is bound.

## 5. Attach the verification report (tester)

```bash
acp --actor "$ACTOR_TEST" task evidence add \
  --task "$TASK_ID" \
  --kind verification_report \
  --ref report:qa-2026-05-09-orders \
  --producer-role tester
```

## 6. Transition green -> verified (tester only; SoD enforced)

```bash
acp --actor "$ACTOR_TEST" task transition \
  --task "$TASK_ID" \
  --to verified \
  --actor-role tester \
  --idempotency-key "scenario:hotfix:$TASK_ID:green-verified"
```

If you attempt this with `--actor "$ACTOR_IMPL" --actor-role tester`, the kernel rejects with `sod_violation` (acting actor coincides with the implementer binding).

## 7. Close as success (implementer)

```bash
acp --actor "$ACTOR_IMPL" task transition \
  --task "$TASK_ID" \
  --to completed \
  --actor-role implementer \
  --idempotency-key "scenario:hotfix:$TASK_ID:close"
```

In the new kernel this maps to `transitionId=close_success` -> `{ status: closed, outcome: success }`.

## Inspect

```bash
acp task show --task "$TASK_ID" --json
acp task transitions --task "$TASK_ID" --json
```

## Negative checks (run only if exercising failure paths)

- Skip step 3 and try step 4: expect rejection `missing_evidence` citing `commit_ref` and `regression_test`.
- Skip step 5 and try step 6: expect rejection `missing_evidence` citing `verification_report`.
- Run step 6 with `--actor "$ACTOR_IMPL" --actor-role tester`: expect rejection `role_not_bound` (ACTOR_IMPL is not bound to the tester role). Note: this rejects before reaching the SoD check.
- To exercise `sod_violation` specifically: create a task where the same actor is bound to both `implementer` and `tester`, advance to green phase, then apply `verify`. The `mustDifferFrom` check fires and rejects with `sod_violation`.
