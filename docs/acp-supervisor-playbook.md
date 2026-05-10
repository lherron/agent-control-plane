# ACP Supervisor Playbook

Read this file top to bottom when you are the supervisor agent for an ACP
workflow task. Drive the task from assignment to terminal state through the ACP
CLI. Keep the workflow definition, task snapshot, supervisor run, participant
runs, evidence records, obligations, and patch proposals aligned before every
state-changing command.

Use stable shell variables for each workflow run. Replace the example values
once, then reuse the commands exactly.

```bash
export ACP_SERVER_URL="http://127.0.0.1:18470"
export ACP_SUPERVISOR="agent:rex"
export ACP_SUPERVISOR_ID="rex"
export ACP_ACTOR_AGENT_ID="$ACP_SUPERVISOR_ID"
export ACP_PROJECT="agent-spaces"
export ACP_TASK_ID="T-WORKFLOW-001"
export ACP_WORKFLOW_REF="evidence_provenance_demo@1"
export ACP_IDEMPOTENCY_PREFIX="supervisor:${ACP_TASK_ID}:$(date -u +%Y%m%dT%H%M%SZ)"
```

## 1. When to read this

Read this when you are the supervisor agent runtime assigned to an ACP workflow
task, or when you are about to start the supervisor run for that task. Run these
commands from your own supervisor session. Dispatch participant work to real
role-scoped participant runtimes; do not replace participant execution with
operator-issued `--as agent:<participant>` commands.

Run the diagnostic first. If the task already exists, inspect it before doing
anything else. If the task does not exist yet, publish the workflow definition
and establish supervision before launching participants.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

If the command returns `not_found`, continue to section 3. If the command
returns a task, continue to section 2.

## 2. Identify yourself and the task

Confirm the actor identity, task id, workflow version, role bindings,
supervisor binding, supervisor capabilities, task version, evidence,
obligations, participant runs, and existing supervisor runs.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

Set the values from the snapshot.

```bash
export ACP_TASK_VERSION="0"
export ACP_SUPERVISOR_RUN_ID="supv_0001"
export ACP_CONTEXT_HASH="sha256:replace-with-context-hash"
export ACP_BOUND_ROLE="implementer"
export ACP_BOUND_AGENT="larry"
```

Refresh supervisor context with your actual run id. Pass capabilities when you
need `allowedControlActions` rendered in the context; use the task snapshot as
the source of truth for persisted supervisor capabilities.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow supervisor-context \
  --task "$ACP_TASK_ID" \
  --run "$ACP_SUPERVISOR_RUN_ID" \
  --capabilities '{"launchRuns":true,"attachEvidence":true,"applySupervisorTransitions":true,"pauseSupervision":true}' \
  --idempotency-prefix "$ACP_IDEMPOTENCY_PREFIX:context"
```

If the actor in the task snapshot does not match your assigned supervisor
identity, stop. DM the coordinator with the current task id, the supervisor
actor in the snapshot, your local actor id, and the command you tried.

## 3. Publish the workflow definition

Publish the workflow definition before creating or supervising a task pinned to
that workflow. Use the workflow JSON selected by the assignment or by the
scenario/preset.

```bash
acp --server "$ACP_SERVER_URL" --json workflow publish \
  ./scenarios/flow-presets/evidence-provenance-attach/workflow.json
```

Read the returned `definition.workflow.id`, `definition.workflow.version`, and
`definition.workflow.hash`. Set `ACP_WORKFLOW_REF` to the returned
`id@version`.

```bash
export ACP_WORKFLOW_REF="evidence_provenance_demo@1"
```

If publish fails with `route not found`, the ACP server is stale for the
workflow surface. Stop and DM the coordinator with the server URL and the
failing command.

## 4. Establish supervision

Create the task and supervisor run in one command when the task does not
already exist. Bind every required role in the workflow definition.

```bash
acp --server "$ACP_SERVER_URL" --json supervise \
  --workflow "$ACP_WORKFLOW_REF" \
  --project "$ACP_PROJECT" \
  --task-id "$ACP_TASK_ID" \
  --goal "Drive the assigned workflow task to terminal state" \
  --risk medium \
  --bind implementer=agent:larry \
  --bind tester=agent:curly \
  --supervisor "$ACP_SUPERVISOR" \
  --autonomy managed \
  --supervisor-capability launchRuns,attachEvidence,applySupervisorTransitions,pauseSupervision,createWaivers,satisfyObligations \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:supervise"
```

Capture `supervisorRun.runId`, `supervisorRun.contextHash`, and `task.version`
from the output.

```bash
export ACP_SUPERVISOR_RUN_ID="supv_0001"
export ACP_CONTEXT_HASH="sha256:replace-with-context-hash"
export ACP_TASK_VERSION="0"
```

Resume supervision for an existing task by task id. Let the server allocate the
new supervisor run id unless the assignment gives a run id that is known to be
unused.

```bash
acp --server "$ACP_SERVER_URL" --json workflow supervise \
  --task "$ACP_TASK_ID" \
  --supervisor "$ACP_SUPERVISOR" \
  --resume \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:resume"
```

If the resume command returns a unique-constraint error for a supplied `--run`,
retry without `--run`, refresh `acp task show`, and record the rejected command
in your handoff.

## 5. Launch participants

Choose the first participant from the workflow definition and current state.
Prefer a role that has a legal transition from the current phase or a dispatch
entry under the workflow supervisor section. Do not launch an optional role
unless the current transition, obligation, or supervisor context requires it.

Launch each role-bound participant through the user-direct participant runtime
surface.

```bash
acp --server "$ACP_SERVER_URL" --json task run \
  --task "$ACP_TASK_ID" \
  --role "$ACP_BOUND_ROLE" \
  --agent "$ACP_BOUND_AGENT" \
  --as "agent:$ACP_BOUND_AGENT" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:run:$ACP_BOUND_ROLE"
```

Capture `participantRun.runId`.

```bash
export ACP_PARTICIPANT_RUN_ID="prun_0001"
```

Confirm the participant run is persisted.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

If launch returns `role_not_bound`, re-check `task.roleBindings`. If the role is
unbound, bind it through the correct task creation/supervision path or ask the
coordinator for a new binding. If the role is bound to another agent, do not
self-claim the role.

## 6. Review evidence as it lands

Use `acp task show` as the evidence ledger. Read `evidence[]`, each
`evidenceId`, `kind`, `ref`, `summary`, `actor`, `role`, `participantRunId`,
and `supervisorRunId`.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

Look up allowed evidence kinds in the workflow definition before attaching a
record. Use role-bound evidence when you are recording a participant output
directly as that role.

```bash
acp --server "$ACP_SERVER_URL" --json task evidence add \
  --task "$ACP_TASK_ID" \
  --kind commit_ref \
  --ref "git:agent-spaces@abcdef1" \
  --summary "Participant produced the requested patch" \
  --as "agent:$ACP_BOUND_AGENT" \
  --role "$ACP_BOUND_ROLE" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:evidence:$ACP_BOUND_ROLE:commit"
```

Use `--from-run` when binding evidence to a participant run. This is the
preferred input for supervisor administrative transition authority.

```bash
acp --server "$ACP_SERVER_URL" --json task evidence add \
  --task "$ACP_TASK_ID" \
  --kind regression_test \
  --ref "test:workflow.regression.pass" \
  --summary "Participant run reports the regression test passes" \
  --as "agent:$ACP_BOUND_AGENT" \
  --from-run "$ACP_PARTICIPANT_RUN_ID" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:evidence:$ACP_PARTICIPANT_RUN_ID:regression"
```

Record supervisor evaluation evidence only when the supervisor has
`attachEvidence` in the task snapshot.

```bash
acp --server "$ACP_SERVER_URL" --json task evidence add \
  --task "$ACP_TASK_ID" \
  --kind supervisor_note \
  --ref "note:supervisor-review" \
  --summary "Supervisor reviewed participant evidence and found it sufficient" \
  --as "$ACP_SUPERVISOR" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:evidence:supervisor-review"
```

If supervisor evidence attach returns `capability_not_granted`, stop using
supervisor evidence for this run and escalate with the missing capability
`attachEvidence`.

Complete participant runs when their assigned output is recorded.

```bash
acp --server "$ACP_SERVER_URL" --json task run-complete \
  --run "$ACP_PARTICIPANT_RUN_ID" \
  --outcome success \
  --evidence-ref evd_0001 \
  --summary "Participant completed the assigned role output" \
  --as "agent:$ACP_BOUND_AGENT" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:run-complete:$ACP_PARTICIPANT_RUN_ID"
```

## 7. Apply transitions

Refresh the task immediately before every transition. Use the returned
`task.version` as `--expected-version` when you want optimistic concurrency
protection.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

Apply a role-authorized transition as the bound role actor. Existing task
evidence satisfies workflow evidence requirements by kind. Use inline
`--evidence kind=ref` only when you need the transition command itself to attach
new evidence.

Treat role-mode `--evidence-ref` as event/audit metadata on the current surface;
transition eligibility is evaluated from task evidence by kind plus any inline
`--evidence kind=ref`. Do not give role-mode `--evidence-ref` the same
authority meaning as supervisor `evidenceRefs`.

```bash
acp --server "$ACP_SERVER_URL" --json task transition \
  --task "$ACP_TASK_ID" \
  --transition close_success \
  --role "$ACP_BOUND_ROLE" \
  --as "agent:$ACP_BOUND_AGENT" \
  --expected-version "$ACP_TASK_VERSION" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:transition:close-success"
```

Apply an evidence-backed administrative transition as supervisor only when the
supervisor run has `applySupervisorTransitions` and the evidence records came
from participant runs. The command records
`authority='supervisor_from_participant_evidence'` on the transition event.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow action \
  --task "$ACP_TASK_ID" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --action '{"type":"apply_transition","transitionId":"implement_fix","evidenceRefs":["evd_0001","evd_0002"]}' \
  --expected-version "$ACP_TASK_VERSION" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:supervisor-transition:implement-fix"
```

Use `--waiver-ref` on approval or closure transitions whose workflow definition
requires a waiver. Pass the waived obligation id returned by
`acp task obligation waive`.

```bash
acp --server "$ACP_SERVER_URL" --json task transition \
  --task "$ACP_TASK_ID" \
  --transition approve \
  --role "$ACP_BOUND_ROLE" \
  --as "agent:$ACP_BOUND_AGENT" \
  --expected-version "$ACP_TASK_VERSION" \
  --waiver-ref obl_0001 \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:transition:approve-with-waiver"
```

If the transition returns `missing_evidence`, gather the required evidence kind
first. If it returns `capability_not_granted`, escalate with the missing
supervisor capability. If it returns `authority_not_granted`, re-check the
actor, role, participant run provenance, and supervisor run id. If it returns
`version_conflict`, run `acp task show`, update `ACP_TASK_VERSION`, and retry
with a new idempotency key.

## 8. Pause / unpause supervision

Pause only when you are blocked on external review, waiting for a participant,
or intentionally yielding supervisor control. Confirm `pauseSupervision` is
present in the task snapshot before pausing.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow action \
  --task "$ACP_TASK_ID" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --action '{"type":"pause_supervision","reason":"Waiting on external review"}' \
  --expected-version "$ACP_TASK_VERSION" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:pause"
```

Verify the run is paused by reading `supervisorRuns[]` and recent events.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

Unpause when the blocker clears. Unpause is allowed while paused even when
other control actions are rejected with `supervisor_paused`.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow action \
  --task "$ACP_TASK_ID" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --action '{"type":"unpause_supervision","reason":"External review cleared"}' \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:unpause"
```

If pause returns `capability_not_granted`, continue without pausing and DM the
coordinator that this supervisor run lacks `pauseSupervision`.

## 9. Handle rejections

Treat every rejection as a branch, not as a reason to guess.

For `capability_not_granted`, stop the attempted supervisor action. Run
`acp task show`, copy the supervisor capabilities from the snapshot, and DM the
coordinator with the missing capability name.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

For `authority_not_granted`, re-check actor and scope alignment. Confirm the
`--as` actor is the bound role actor for role commands. Confirm the
`--supervisor-run` belongs to this task and supervisor actor for supervisor
commands. Confirm participant-run evidence uses `--from-run` from this task.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow supervisor-context \
  --task "$ACP_TASK_ID" \
  --run "$ACP_SUPERVISOR_RUN_ID" \
  --idempotency-prefix "$ACP_IDEMPOTENCY_PREFIX:reject-authority"
```

For `missing_evidence`, inspect `unavailableTransitions[]`, the workflow
definition, and `evidence[]`. Attach the missing kind, then retry with a new
idempotency key.

```bash
acp --server "$ACP_SERVER_URL" --json task evidence add \
  --task "$ACP_TASK_ID" \
  --kind regression_test \
  --ref "test:missing-evidence-now-present" \
  --summary "Added evidence required by the rejected transition" \
  --as "agent:$ACP_BOUND_AGENT" \
  --from-run "$ACP_PARTICIPANT_RUN_ID" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:evidence:missing-remediation"
```

For `waiver_required`, waive the blocking obligation and pass the obligation id
as `--waiver-ref` on the transition.

```bash
acp --server "$ACP_SERVER_URL" --json task obligation waive \
  --task "$ACP_TASK_ID" \
  --obligation obl_0001 \
  --reason "Supervisor accepted an explicit waiver path for this obligation" \
  --evidence-ref evd_0001 \
  --actor "$ACP_SUPERVISOR_ID" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:waive:obl_0001"
```

For `open_blocking_obligation`, list obligations with `acp task show`. Satisfy
or waive each open blocking obligation before retrying the transition.

```bash
acp --server "$ACP_SERVER_URL" --actor "$ACP_SUPERVISOR_ID" --json workflow action \
  --task "$ACP_TASK_ID" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --action '{"type":"satisfy_obligation","obligationId":"obl_0001","evidence":[{"kind":"supervisor_note","ref":"note:obligation-satisfied","summary":"Supervisor verified the blocking obligation is satisfied"}]}' \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:satisfy:obl_0001"
```

For `version_conflict`, refresh the task, export the new version, and retry the
same logical action with a new idempotency key.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

## 10. Patch proposal review

Survey participant-emitted workflow patch proposals before closing or before
declaring that the workflow cannot proceed.

```bash
acp --server "$ACP_SERVER_URL" --json workflow patch list \
  --task "$ACP_TASK_ID"
```

Inspect any proposal that is `open` or `pending_review`.

```bash
acp --server "$ACP_SERVER_URL" --json workflow patch show \
  patch_0001
```

Record review evidence before accepting or rejecting a patch.

```bash
acp --server "$ACP_SERVER_URL" --json task evidence add \
  --task "$ACP_TASK_ID" \
  --kind supervisor_note \
  --ref "patch-review:patch_0001" \
  --summary "Supervisor reviewed patch_0001 and selected the transition path" \
  --as "$ACP_SUPERVISOR" \
  --supervisor-run "$ACP_SUPERVISOR_RUN_ID" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:evidence:patch-review:patch_0001"
```

Apply or reject a patch through the transition defined by the workflow. Use the
transition id from the workflow definition or supervisor context.

```bash
acp --server "$ACP_SERVER_URL" --json task transition \
  --task "$ACP_TASK_ID" \
  --transition reject_patch \
  --role "$ACP_BOUND_ROLE" \
  --as "agent:$ACP_BOUND_AGENT" \
  --expected-version "$ACP_TASK_VERSION" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:transition:reject-patch"
```

If the workflow does not define patch acceptance or rejection transitions, DM
the coordinator with the proposal id and the missing transition.

## 11. Close the task

Close only when the workflow state permits a terminal transition, required
evidence is present, participant runs that matter are completed or explicitly
failed, blocking obligations are satisfied or waived, and patch proposals have
been reviewed.

Refresh the task and set the current version.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

Apply the terminal transition with the current expected version.

```bash
acp --server "$ACP_SERVER_URL" --json task transition \
  --task "$ACP_TASK_ID" \
  --transition close_success \
  --role "$ACP_BOUND_ROLE" \
  --as "agent:$ACP_BOUND_AGENT" \
  --expected-version "$ACP_TASK_VERSION" \
  --idempotency-key "$ACP_IDEMPOTENCY_PREFIX:transition:close"
```

Verify final state.

```bash
acp --server "$ACP_SERVER_URL" --json task show \
  --task "$ACP_TASK_ID"
```

The task is complete when `task.state.status` is `closed`, `task.state.outcome`
matches the intended outcome, all required evidence records are present, no
open blocking obligations remain, and the final `transition.applied` event is
visible in `events[]`.

## 12. When you cannot proceed

Stop and DM the human-in-the-loop coordinator when you cannot repair the state
with the branches above. Include the current state, last action attempted, exact
error code or message, and the input you need.

```bash
hrcchat dm clod@agent-spaces - <<'EOF'
T-XXXX blocker:
- Current task: T-WORKFLOW-001, state active/implementing, version 3.
- Supervisor run: supv_0001, actor agent:rex.
- Last command: acp workflow action --task T-WORKFLOW-001 --supervisor-run supv_0001 --action '{"type":"apply_transition","transitionId":"implement_fix","evidenceRefs":["evd_0001"]}'.
- Error: authority_not_granted.
- Needed input: confirm whether agent:rex is the intended supervisor or provide a new supervisor run with applySupervisorTransitions.
EOF
```

Do not invent a transition, self-bind a role, ignore an open blocking
obligation, or bypass a missing waiver.

## Related docs

- [ACP workflow verification](./acp-workflow-verification.md)
- [ACP workflow checkpoints validation](../acp-workflow-checkpoints-validation.md)
- [Flow presets README](../scenarios/flow-presets/README.md)

## Validation walk

Required real-runtime walk performed on 2026-05-10T13:41:17Z. This session acted
as the supervisor runtime `larry@agent-spaces:T-01403`. It dispatched the
role-scoped participant runtime
`curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector` and did not replace
participant execution with operator-issued participant `--as` commands.

Start a fresh source ACP server for the real-runtime walk.

```bash
ACP_PORT=18484 ACP_STATE_DB_PATH=/tmp/acp-playbook-T01403-real-state.db ACP_COORD_DB_PATH=/tmp/acp-playbook-T01403-real-coord.db ACP_ADMIN_DB_PATH=/tmp/acp-playbook-T01403-real-admin.db ACP_JOBS_DB_PATH=/tmp/acp-playbook-T01403-real-jobs.db ACP_INTERFACE_DB_PATH=/tmp/acp-playbook-T01403-real-interface.db ACP_CONVERSATION_DB_PATH=/tmp/acp-playbook-T01403-real-conversation.db bun packages/acp-server/src/cli.ts --host 127.0.0.1 --port 18484 --state-db-path /tmp/acp-playbook-T01403-real-state.db --coord-db-path /tmp/acp-playbook-T01403-real-coord.db --admin-db-path /tmp/acp-playbook-T01403-real-admin.db --jobs-db-path /tmp/acp-playbook-T01403-real-jobs.db --interface-db-path /tmp/acp-playbook-T01403-real-interface.db --conversation-db-path /tmp/acp-playbook-T01403-real-conversation.db
# acp-server listening on http://127.0.0.1:18484 ... state.db = /tmp/acp-playbook-T01403-real-state.db ...
```

Publish the workflow.

```bash
acp --server http://127.0.0.1:18484 --json workflow publish ./scenarios/flow-presets/evidence-provenance-attach/workflow.json
# {
#   "definition": {
#     "id": "evidence_provenance_demo",
#     "version": 1,
#     "hash": "sha256:3d8879df4569c1c251cee9883db773303f0c865aa2c2574d9293eae1a1f9fd19"
#   }
# }
```

Create the task and supervisor run as the real supervisor runtime.

```bash
acp --server http://127.0.0.1:18484 --json supervise --workflow evidence_provenance_demo@1 --project agent-spaces --task-id T-01403-REAL-20260510T134117Z --goal "Collect evidence through a real participant runtime for T-01403 playbook validation" --risk low --bind collector=agent:curly --supervisor agent:larry --autonomy managed --supervisor-capability launchRuns,attachEvidence --idempotency-key T-01403:real:create:20260510T134117Z
# {
#   "ok": true,
#   "task": {
#     "taskId": "T-01403-REAL-20260510T134117Z",
#     "state": { "status": "active", "phase": "collect" },
#     "version": 0,
#     "roleBindings": { "collector": { "kind": "agent", "id": "curly" } },
#     "supervisor": { "actor": { "kind": "agent", "id": "larry" }, "capabilities": { "launchRuns": true, "attachEvidence": true } }
#   },
#   "supervisorRun": { "runId": "supv_0002", "contextHash": "sha256:79c4bcdff3b40e1a69bec213d586b864771b551e45d63f8359dc9676d937e835" }
# }
```

Record supervisor evidence as the supervisor runtime.

```bash
acp --server http://127.0.0.1:18484 --json task evidence add --task T-01403-REAL-20260510T134117Z --kind supervisor_note --ref note:T-01403-real-supervisor --summary "Supervisor runtime larry created traceability note before dispatching collector" --as agent:larry --supervisor-run supv_0002 --idempotency-key T-01403:real:evidence:supervisor:20260510T134117Z
# {
#   "evidence": [{
#     "evidenceId": "evd_0004",
#     "actor": { "kind": "agent", "id": "larry" },
#     "supervisorRunId": "supv_0002",
#     "kind": "supervisor_note"
#   }]
# }
```

Dispatch the collector participant runtime.

```bash
hrcchat dm curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector - <<'EOF'
You are the collector participant runtime for ACP validation task T-01403-REAL-20260510T134117Z.

Use the real ACP server at http://127.0.0.1:18484 from /Users/lherron/praesidium/agent-spaces. Please execute these commands yourself as the bound collector agent curly, then reply with the command outputs and any evidence/run ids:

1. acp --server http://127.0.0.1:18484 --json task run --task T-01403-REAL-20260510T134117Z --role collector --agent curly --as agent:curly --idempotency-key T-01403:real:participant-run:curly:20260510T134117Z
2. Capture participantRun.runId.
3. acp --server http://127.0.0.1:18484 --json task evidence add --task T-01403-REAL-20260510T134117Z --kind field_note --ref note:T-01403-real-curly-field --summary "Real collector runtime curly attached field note" --as agent:curly --role collector --idempotency-key T-01403:real:evidence:field:curly:20260510T134117Z
4. acp --server http://127.0.0.1:18484 --json task evidence add --task T-01403-REAL-20260510T134117Z --kind participant_artifact --ref artifact:T-01403-real-curly-output --summary "Real collector runtime curly attached participant artifact" --as agent:curly --from-run <participantRun.runId> --idempotency-key T-01403:real:evidence:artifact:curly:20260510T134117Z
5. acp --server http://127.0.0.1:18484 --json task run-complete --run <participantRun.runId> --outcome success --evidence-ref <participant_artifact evidenceId> --summary "Real collector runtime completed collection" --as agent:curly --idempotency-key T-01403:real:run-complete:curly:20260510T134117Z

Do not modify repository files. This is a live ACP smoke walk only.
EOF
# dm sent to curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector (seq: 1761)
```

Participant runtime reply:

```text
#1765 curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector -> larry@agent-spaces:T-01403
Collector participant run completed successfully. All 5 steps executed against real ACP at http://127.0.0.1:18484.

Results summary:
1. Participant run registered -> prun_0006 (role: collector, agent: curly, status: launched)
2. runId captured -> prun_0006
3. field_note evidence added -> evd_0008 (ref: note:T-01403-real-curly-field)
4. participant_artifact evidence added -> evd_0010 (ref: artifact:T-01403-real-curly-output, linked to prun_0006)
5. Run completed -> prun_0006 status: completed, outcome: success, evidenceRef: evd_0010
```

Dispatch the role-authorized close transition back to the collector runtime.

```bash
hrcchat dm curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector - <<'EOF'
Please complete the role-authorized close step for ACP validation task T-01403-REAL-20260510T134117Z using the real ACP server.

Run this command from /Users/lherron/praesidium/agent-spaces and reply with the output:

acp --server http://127.0.0.1:18484 --json task transition --task T-01403-REAL-20260510T134117Z --transition close_success --role collector --as agent:curly --expected-version 0 --idempotency-key T-01403:real:close:curly:20260510T134117Z

Do not modify repository files.
EOF
# dm sent to curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector (seq: 1769)
```

Participant runtime close reply:

```text
#1772 curly@agent-spaces:T-01403-REAL-20260510T134117Z/collector -> larry@agent-spaces:T-01403
Role-authorized close completed successfully.

Result:
- Task T-01403-REAL-20260510T134117Z transitioned via close_success
- State: active/collect -> closed/collect/success
- Task version: 0 -> 1
- Event: wevt_0013 (transition.applied)
```

Verify the final task snapshot as the supervisor runtime.

```bash
acp --server http://127.0.0.1:18484 --json task show --task T-01403-REAL-20260510T134117Z
# {
#   "task": {
#     "taskId": "T-01403-REAL-20260510T134117Z",
#     "state": { "status": "closed", "phase": "collect", "outcome": "success" },
#     "version": 1,
#     "roleBindings": { "collector": { "kind": "agent", "id": "curly" } },
#     "supervisor": { "actor": { "kind": "agent", "id": "larry" } }
#   },
#   "evidence": [
#     { "evidenceId": "evd_0004", "kind": "supervisor_note", "actor": { "id": "larry" }, "supervisorRunId": "supv_0002" },
#     { "evidenceId": "evd_0008", "kind": "field_note", "actor": { "id": "curly" }, "role": "collector" },
#     { "evidenceId": "evd_0010", "kind": "participant_artifact", "actor": { "id": "curly" }, "participantRunId": "prun_0006" }
#   ],
#   "participantRuns": [{ "runId": "prun_0006", "actor": { "id": "curly" }, "role": "collector", "status": "completed" }],
#   "events": [
#     { "type": "participant_run.launched", "actor": { "id": "curly" }, "participantRunId": "prun_0006" },
#     { "type": "participant_run.completed", "actor": { "id": "curly" }, "participantRunId": "prun_0006" },
#     { "type": "transition.applied", "actor": { "id": "curly" }, "payload": { "transitionId": "close_success", "role": "collector" } }
#   ]
# }
```

Initial CLI grounding walk performed by larry on 2026-05-10T13:33:18Z against a
fresh source ACP server on `http://127.0.0.1:18483`, using isolated state
databases under `/tmp/acp-playbook-T01403-*.db` and the
`scenarios/flow-presets/evidence-provenance-attach/workflow.json` preset.

The shared dev ACP at `http://127.0.0.1:18470` returned `route not found` for
`acp workflow publish`, so the walk used a source server from this checkout.
The command below started that server:

```bash
ACP_PORT=18483 ACP_STATE_DB_PATH=/tmp/acp-playbook-T01403-state.db ACP_COORD_DB_PATH=/tmp/acp-playbook-T01403-coord.db ACP_ADMIN_DB_PATH=/tmp/acp-playbook-T01403-admin.db ACP_JOBS_DB_PATH=/tmp/acp-playbook-T01403-jobs.db ACP_INTERFACE_DB_PATH=/tmp/acp-playbook-T01403-interface.db ACP_CONVERSATION_DB_PATH=/tmp/acp-playbook-T01403-conversation.db bun packages/acp-server/src/cli.ts --host 127.0.0.1 --port 18483 --state-db-path /tmp/acp-playbook-T01403-state.db --coord-db-path /tmp/acp-playbook-T01403-coord.db --admin-db-path /tmp/acp-playbook-T01403-admin.db --jobs-db-path /tmp/acp-playbook-T01403-jobs.db --interface-db-path /tmp/acp-playbook-T01403-interface.db --conversation-db-path /tmp/acp-playbook-T01403-conversation.db
# acp-server listening on http://127.0.0.1:18483 ... state.db = /tmp/acp-playbook-T01403-state.db ...
```

Publish the workflow.

```bash
acp --server http://127.0.0.1:18483 --json workflow publish ./scenarios/flow-presets/evidence-provenance-attach/workflow.json
# {
#   "definition": {
#     "id": "evidence_provenance_demo",
#     "version": 1,
#     "hash": "sha256:3d8879df4569c1c251cee9883db773303f0c865aa2c2574d9293eae1a1f9fd19"
#   }
# }
```

Create the task and supervisor run.

```bash
acp --server http://127.0.0.1:18483 --json supervise --workflow evidence_provenance_demo@1 --project agent-spaces --task-id T-01403-PLAYBOOK-20260510T133318Z --goal "Collect three evidence records for T-01403 playbook validation" --risk low --bind collector=agent:larry --supervisor agent:rex --autonomy managed --supervisor-capability launchRuns,attachEvidence --idempotency-key T-01403:playbook:create:20260510T133318Z
# {
#   "ok": true,
#   "task": {
#     "taskId": "T-01403-PLAYBOOK-20260510T133318Z",
#     "state": { "status": "active", "phase": "collect" },
#     "version": 0,
#     "roleBindings": { "collector": { "kind": "agent", "id": "larry" } },
#     "supervisor": { "actor": { "kind": "agent", "id": "rex" }, "capabilities": { "launchRuns": true, "attachEvidence": true } }
#   },
#   "supervisorRun": { "runId": "supv_0002", "contextHash": "sha256:e95c021552f0ad90942f03caf9afd7e182971bc274cdf47dedb7336801eac505" }
# }
```

Inspect the task.

```bash
acp --server http://127.0.0.1:18483 --json task show --task T-01403-PLAYBOOK-20260510T133318Z
# {
#   "task": { "taskId": "T-01403-PLAYBOOK-20260510T133318Z", "state": { "status": "active", "phase": "collect" }, "version": 0 },
#   "evidence": [],
#   "supervisorRuns": [{ "runId": "supv_0002", "capabilities": { "launchRuns": true, "attachEvidence": true } }],
#   "participantRuns": []
# }
```

Attach role-bound evidence.

```bash
acp --server http://127.0.0.1:18483 --json task evidence add --task T-01403-PLAYBOOK-20260510T133318Z --kind field_note --ref note:T-01403-role-bound --summary "Role-bound collector field note for playbook validation" --as agent:larry --role collector --idempotency-key T-01403:playbook:evidence:role:20260510T133318Z
# {
#   "evidence": [{
#     "evidenceId": "evd_0004",
#     "actor": { "kind": "agent", "id": "larry" },
#     "role": "collector",
#     "kind": "field_note",
#     "ref": "note:T-01403-role-bound"
#   }]
# }
```

Attach supervisor evidence.

```bash
acp --server http://127.0.0.1:18483 --json task evidence add --task T-01403-PLAYBOOK-20260510T133318Z --kind supervisor_note --ref note:T-01403-supervisor --summary "Supervisor traceability note for playbook validation" --as agent:rex --supervisor-run supv_0002 --idempotency-key T-01403:playbook:evidence:supervisor:20260510T133318Z
# {
#   "evidence": [{
#     "evidenceId": "evd_0006",
#     "actor": { "kind": "agent", "id": "rex" },
#     "supervisorRunId": "supv_0002",
#     "kind": "supervisor_note",
#     "ref": "note:T-01403-supervisor"
#   }]
# }
```

Launch the collector participant run.

```bash
acp --server http://127.0.0.1:18483 --json task run --task T-01403-PLAYBOOK-20260510T133318Z --role collector --agent larry --as agent:larry --idempotency-key T-01403:playbook:run:collector:20260510T133318Z
# {
#   "ok": true,
#   "participantRun": {
#     "runId": "prun_0008",
#     "role": "collector",
#     "actor": { "kind": "agent", "id": "larry" },
#     "status": "launched"
#   }
# }
```

Attach participant-run evidence.

```bash
acp --server http://127.0.0.1:18483 --json task evidence add --task T-01403-PLAYBOOK-20260510T133318Z --kind participant_artifact --ref artifact:T-01403-run-output --summary "Participant run artifact for playbook validation" --as agent:larry --from-run prun_0008 --idempotency-key T-01403:playbook:evidence:participant:20260510T133318Z
# {
#   "evidence": [{
#     "evidenceId": "evd_0010",
#     "role": "collector",
#     "runId": "prun_0008",
#     "participantRunId": "prun_0008",
#     "kind": "participant_artifact",
#     "ref": "artifact:T-01403-run-output"
#   }]
# }
```

Complete the participant run.

```bash
acp --server http://127.0.0.1:18483 --json task run-complete --run prun_0008 --outcome success --evidence-ref evd_0010 --summary "Collector participant run produced required artifact" --as agent:larry --idempotency-key T-01403:playbook:run-complete:20260510T133318Z
# {
#   "ok": true,
#   "participantRun": {
#     "runId": "prun_0008",
#     "status": "completed",
#     "outcome": "success"
#   }
# }
```

Verify evidence and participant run state before closure.

```bash
acp --server http://127.0.0.1:18483 --json task show --task T-01403-PLAYBOOK-20260510T133318Z
# {
#   "task": { "state": { "status": "active", "phase": "collect" }, "version": 0 },
#   "evidence": [
#     { "evidenceId": "evd_0004", "kind": "field_note" },
#     { "evidenceId": "evd_0006", "kind": "supervisor_note" },
#     { "evidenceId": "evd_0010", "kind": "participant_artifact", "participantRunId": "prun_0008" }
#   ],
#   "participantRuns": [{ "runId": "prun_0008", "status": "completed" }]
# }
```

Close the task.

```bash
acp --server http://127.0.0.1:18483 --json task transition --task T-01403-PLAYBOOK-20260510T133318Z --transition close_success --role collector --as agent:larry --expected-version 0 --idempotency-key T-01403:playbook:close:20260510T133318Z
# {
#   "ok": true,
#   "task": {
#     "taskId": "T-01403-PLAYBOOK-20260510T133318Z",
#     "state": { "status": "closed", "phase": "collect", "outcome": "success" },
#     "version": 1
#   },
#   "event": { "type": "transition.applied", "payload": { "transitionId": "close_success", "role": "collector" } }
# }
```

Verify the final state.

```bash
acp --server http://127.0.0.1:18483 --json task show --task T-01403-PLAYBOOK-20260510T133318Z
# {
#   "task": {
#     "taskId": "T-01403-PLAYBOOK-20260510T133318Z",
#     "state": { "status": "closed", "phase": "collect", "outcome": "success" },
#     "version": 1
#   },
#   "evidence": [
#     { "evidenceId": "evd_0004", "kind": "field_note" },
#     { "evidenceId": "evd_0006", "kind": "supervisor_note" },
#     { "evidenceId": "evd_0010", "kind": "participant_artifact", "participantRunId": "prun_0008" }
#   ],
#   "participantRuns": [{ "runId": "prun_0008", "status": "completed" }]
# }
```

Check patch proposals.

```bash
acp --server http://127.0.0.1:18483 --json workflow patch list --task T-01403-PLAYBOOK-20260510T133318Z
# {
#   "proposals": []
# }
```

Resume supervision against the existing task.

```bash
acp --server http://127.0.0.1:18483 --json workflow supervise --task T-01403-PLAYBOOK-20260510T133318Z --supervisor agent:rex --resume --idempotency-key T-01403:playbook:resume-no-run:20260510T133318Z
# {
#   "ok": true,
#   "task": { "state": { "status": "closed", "phase": "collect", "outcome": "success" }, "version": 1 },
#   "supervisorRun": { "runId": "supv_0014", "taskVersionAtStart": 1 }
# }
```

Adjustments recorded during the walk:

- Use a source ACP server when the shared dev server returns `route not found`
  for workflow routes.
- Do not resume an existing supervisor run by passing an already-used
  `--run`; the tested command returned `UNIQUE constraint failed:
  workflow_supervisor_runs.run_id`. Resume by task id and let the server return
  a new `supervisorRun.runId`.
- Use `acp task transition` with existing task evidence and optional inline
  `--evidence kind=ref`; use `acp workflow action` with JSON `evidenceRefs` for
  supervisor evidence-backed administrative transitions.
