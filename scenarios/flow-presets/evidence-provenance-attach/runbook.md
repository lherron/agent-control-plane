# Runbook — Standalone evidence attach with three-source provenance

End-to-end walkthrough for `evidence_provenance_demo@1` (see `workflow.json` and
`scenario.json`). Exercises ACP Checkpoint E1: EvidenceRecord provenance fields
and the standalone evidence attach API/CLI surface.

## What this scenario proves

1. `EvidenceRecord` carries `actor`, `role?`, `runId?`, `participantRunId?`,
   `supervisorRunId?` provenance fields and round-trips them through the
   workflow runtime persistence layer.
2. `POST /v1/tasks/:taskId/evidence` accepts evidence from three distinct
   authorized actor sources:
   - a role-bound actor for its bound role,
   - the supervisor with explicit `attachEvidence` capability,
   - an actor with a persisted participant run on the task.
3. `acp task evidence add` CLI round-trips with all three sources.
4. Idempotency: same key + same payload replays; same key + different payload
   returns `idempotency_conflict`.
5. Workflow-defined `evidenceKinds` are enforced — unknown kinds are rejected
   with `invalid_evidence`.

## Manual execution

```bash
# 1. Publish workflow
acp workflow publish ./scenarios/flow-presets/evidence-provenance-attach/workflow.json

# 2. Create task with collector + supervisor (with attachEvidence cap)
acp task create \
  --project agent-spaces \
  --workflow evidence_provenance_demo@1 \
  --task-id T-EVIDENCE-PROVENANCE-DEMO \
  --goal "Collect three field-note evidence records demonstrating provenance" \
  --risk low \
  --bind collector=agent:larry \
  --supervisor agent:rex \
  --supervisor-autonomy managed \
  --supervisor-capability attachEvidence \
  --idempotency-key scenario:evidence-provenance:create:v1

# 3. Attach evidence as role-bound collector
acp task evidence add \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --kind field_note \
  --ref note:collector-direct-attach \
  --summary "Field note attached by the role-bound collector" \
  --as agent:larry \
  --role collector \
  --idempotency-key scenario:evidence-provenance:attach:bound-role:v1

# 4. Attach evidence as supervisor
acp task evidence add \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --kind supervisor_note \
  --ref note:supervisor-traceability-attach \
  --summary "Supervisor compliance note" \
  --as agent:rex \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --idempotency-key scenario:evidence-provenance:attach:supervisor:v1

# 5. Launch participant run for collector (records run id RUN_X)
acp workflow action \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --supervisor-run <SUPERVISOR_RUN_ID> \
  --action '{"type":"launch_participant_run","role":"collector","actor":{"kind":"agent","id":"larry"}}' \
  --idempotency-key scenario:evidence-provenance:launch-collector:v1

# 6. Attach evidence via the participant run (use runId from step 5)
acp task evidence add \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --kind participant_artifact \
  --ref artifact:collector-run-output \
  --summary "Artifact produced during participant run" \
  --as agent:larry \
  --from-run <RUN_X> \
  --idempotency-key scenario:evidence-provenance:attach:participant-run:v1

# 7. Idempotency replay (same key + payload as step 3) — expect same evidenceId
acp task evidence add \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --kind field_note \
  --ref note:collector-direct-attach \
  --summary "Field note attached by the role-bound collector" \
  --as agent:larry \
  --role collector \
  --idempotency-key scenario:evidence-provenance:attach:bound-role:v1

# 8. Close
acp task transition \
  --task T-EVIDENCE-PROVENANCE-DEMO \
  --transition close_success \
  --as agent:larry \
  --idempotency-key scenario:evidence-provenance:close:v1
```

## Negative checks

- `unauthorized-actor-cannot-attach` — attempt the attach as `agent:intruder`
  (not bound, not supervisor, no participant run). Expect `authority_not_granted`.
- `supervisor-without-capability-cannot-attach` — recreate the task with the
  supervisor binding lacking `attachEvidence:true`, retry step 4. Expect
  `capability_not_granted`.
- `idempotency-conflict-on-different-payload` — replay step 3 with the same
  idempotency key but `--ref note:DIFFERENT`. Expect `idempotency_conflict`.
- `evidence-kind-not-in-workflow-rejected` — attempt
  `--kind not_declared_kind`. Expect `invalid_evidence`.
- `participant-run-mismatch-rejected` — attempt step 6 with `--from-run` set
  to a runId from a different task. Expect `authority_not_granted`.

## Validation

The scenario is validated by the conformance harness:

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

And by the kernel-level provenance tests landed for T-01392:

```bash
bun test packages/acp-core/src/__tests__/workflow-evidence-provenance.test.ts
bun test packages/acp-server/test/evidence-attach.test.ts
bun test tests/conformance/acp-workflow/evidence-provenance.test.ts
bun test packages/acp-cli/test/commands/evidence-add.test.ts
```
