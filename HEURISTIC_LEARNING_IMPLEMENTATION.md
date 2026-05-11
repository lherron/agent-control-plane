# Heuristic Learning Implementation Log

Date: 2026-05-11

## Phase 1: ACP/HRC Capture Foundation

Status: Complete

Implemented:

- Extended ACP workflow events with `workflowSeq`, `schemaVersion`, `commandType`, `commandHash`, `eventHash`, `prevHash`, `result`, `rejectionCode`, actor role/authority fields, and correlation/causation IDs.
- Ledgered accepted and rejected transition commands in ACP workflow history.
- Added ACP-owned `WorkflowHrcRunMap` records and persistence table `workflow_hrc_run_maps`.
- Wired participant-run launch route to write ACP/HRC mappings when HRC identity fields are supplied.
- Added effect lifecycle events for lease, delivery, failure, and unsupported effect outcomes.
- Changed unsupported effect reconciliation from silent delivery to `unsupported`.

Validation:

- `bun run --filter acp-core build` passed.
- `bun run --filter acp-state-store build` passed.
- `bun run --filter acp-server build` passed.
- `bun run --filter acp-core typecheck` passed.
- `bun run --filter acp-core test` passed: 78 tests.
- `bun run --filter acp-state-store typecheck` passed.
- `bun run --filter acp-state-store test` passed: 7 tests.
- `bun run --filter acp-server typecheck` passed.
- `bun test packages/acp-server/test/workflow-tasks.test.ts` passed: 4 tests.
- `bun test packages/acp-server/test/workflow-participant-runs.test.ts` passed: 5 tests.
- `bun test tests/conformance/acp-workflow` passed: 47 tests.
- `bun run lint` passed with existing warnings.

Deviations:

- Rejected commands for unknown task IDs cannot be attached to a task-scoped workflow event stream. Rejections are ledgered once the target task is known.

## Phase 2: Deterministic Workflow Replay

Status: Complete

Implemented:

- Added `materializeWorkflowTrace` to build workflow traces from ACP workflow events plus ACP/HRC run mappings.
- Added `runDeterministicWorkflowReplay` to validate workflow sequence, event hashes, hash-chain continuity, and rejected-command rejection codes.
- Replay focuses on deterministic workflow equivalence and does not attempt bit-identical LLM replay.

Validation:

- `bun test packages/acp-core/src/__tests__/learning-tools.test.ts` passed.
- Manual smoke: `bun packages/wlearn/bin/wlearn.js replay run --snapshot /tmp/wlearn-smoke-snapshot.json --task smoke-task` returned a replay report with `outcome: "passed"`.

Deviations:

- Replay checks recorded kernel outcomes and event integrity. It does not reconstruct every command from first principles because legacy events before this change did not carry full command envelopes.

## Phase 3: Low-Authority Learning Workflows

Status: Complete

Implemented:

- Added ACP workflow presets:
  - `learning_trace_triage.v1`
  - `learning_trace_labeling.v1`
  - `learning_playbook_update.v1`
  - `learning_curation.v1`
- Added learning roles for Learning Supervisor, Trace Reviewer, Label Reviewer, Playbook Author, Playbook Reviewer, Curator, Correlation Steward, and Learning Auditor.
- Added provenance-bearing trace labels and label review helper with reviewer separation for eval-use labels.
- Added low-authority artifact lifecycle transitions for draft, accepted, active, stale, archived, pinned, and quarantined states.

Validation:

- `bun test packages/acp-core/src/__tests__/learning-workflows.test.ts` passed.
- `bun test packages/acp-core/src/__tests__/learning-tools.test.ts` passed.

Deviations:

- Artifact storage is represented by typed ACP evidence/artifact records and workflow lifecycle helpers. Raw ACP/HRC logs remain immutable and are not duplicated in `wlearn`.

## Phase 4: High-Authority Proposal and Replay Workflows

Status: Complete

Implemented:

- Added ACP workflow presets:
  - `learning_policy_patch.v1`
  - `learning_patch_evaluation.v1`
- Added Patch Author, Evaluator Runner, and Evaluation Steward roles.
- Added `PatchBundle`, `ReplayReport`, and evaluation gate helpers.
- Added evidence-grade-oriented replay/eval report surfaces without low-N operational improvement claims.

Validation:

- `bun test packages/acp-core/src/__tests__/learning-workflows.test.ts` passed.
- `bun test packages/acp-core/src/__tests__/learning-tools.test.ts` passed.

Deviations:

- Statistical Grade C operational claims are intentionally not automated. The implemented gates support deterministic and regression-style claims.

## Phase 5: Promotion, Rollback, and Audit Workflows

Status: Complete

Implemented:

- Added ACP workflow presets:
  - `learning_patch_promotion.v1`
  - `learning_patch_rollback.v1`
  - `learning_audit.v1`
- Added Promotion Reviewer and Learning Auditor roles.
- Added promotion-readiness validation requiring replay/eval reports, role separation, and external authority for high-risk changes.
- Added audit/quarantine/block-promotion workflow transitions.

Validation:

- `bun test packages/acp-core/src/__tests__/learning-workflows.test.ts` passed.
- `bun test packages/acp-core/src/__tests__/learning-tools.test.ts` passed.

Deviations:

- External approval is represented as ACP role/evidence requirements. Actual organization-specific authority binding remains an operator configuration concern.

## Phase 6: Learning-Workflow Self-Improvement Governance

Status: Complete

Implemented:

- Added `learning_workflow_patch.v1` for future-version learning workflow changes.
- Requires meta-evaluation and external review before staged future-version promotion.
- Prevents direct self-promotion by routing changes through ACP role separation and external authority evidence.

Validation:

- `bun run --filter acp-core test` passed.

Deviations:

- The kernel enforces state, evidence, and role-separation gates. It does not parse arbitrary patch bundle contents to prove a bundle only targets future workflow versions; that is represented by workflow evidence requirements and promotion review.

## wlearn Tooling

Status: Complete

Implemented:

- Added `packages/wlearn` as a downstream tool package.
- Commands:
  - `wlearn trace materialize --snapshot <file> --task <workflowTaskId>`
  - `wlearn replay run --snapshot <file> --task <workflowTaskId>`
  - `wlearn hrc summarize-range --hrc-run <hrcRunId> --start <seq> --end <seq>`
  - `wlearn playbook draft --trace <traceId>`
  - `wlearn patch draft --trace <traceId> --target <facet>`
  - `wlearn curate report --scope <scope>`
  - `wlearn promotion submit ...`
- `wlearn` does not expose lifecycle mutation or direct promotion commands.

Validation:

- `bun run --filter wlearn typecheck` passed.
- `bun run --filter wlearn test` passed: 1 test.
- `bun run lint` passed with existing warnings only.
- `bun run test` passed across the root package loop.
- Manual smoke:
  - `bun packages/wlearn/bin/wlearn.js trace materialize --snapshot /tmp/wlearn-smoke-snapshot.json --task smoke-task` returned `correlationState: "fully_correlated"`.
  - `bun packages/wlearn/bin/wlearn.js replay run --snapshot /tmp/wlearn-smoke-snapshot.json --task smoke-task` returned `outcome: "passed"`.

## Blockers

None known.
