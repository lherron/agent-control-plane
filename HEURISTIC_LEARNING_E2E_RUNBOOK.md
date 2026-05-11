# Heuristic Learning E2E Manual Validation Runbook

Companion to `heuristic-learning-acp-hrc-spec.md` and `HEURISTIC_LEARNING_IMPLEMENTATION.md`.

This runbook walks an operator through the MVP vertical slice (spec §17) using **real live agents** dispatched via `hrcchat`, and validates the ACP ledger, ACP↔HRC mapping, effect lifecycle capture, deterministic replay, and the low/high-authority learning workflows end to end.

It is intentionally checklist-shaped. Each step has an **Execute** block (copy-pasteable) and a **Verify** block (what to confirm). Run from `~/praesidium/agent-spaces` unless otherwise noted.

---

## 0. Prerequisites

### 0.1 Tooling

```bash
which acp wlearn hrc hrcchat stackctl sqlite3 jq
```

All six must resolve. `acp` lives in `~/.bun/bin`, `wrkq` in `~/.local/bin`, `stackctl` in `~/.tooling/bin`.

### 0.2 Stack health

```bash
stackctl status dev --brief
acp server status --json
```

ACP and HRC must be healthy/responsive. ACP does not expose `/healthz`; use
`acp server status --json` or `stackctl status dev --brief` as the liveness
check. If you just rebuilt acp-server, restart it so the new event-sourced
kernel and `workflow_hrc_run_maps` migrations are live:

```bash
stackctl restart dev
```

### 0.3 Build is current

```bash
just build              # or: bun run build
bun run --filter acp-core test
bun run --filter acp-state-store test
bun run --filter wlearn test
```

All green.

### 0.4 ACP-state DB schema is migrated

```bash
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT name FROM pragma_table_info('workflow_events') \
   WHERE name IN ('workflow_seq','schema_version','event_hash','prev_hash','rejection_code','command_hash','command_type','result','authority','role');"
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db ".tables workflow_hrc_run_maps"
```

The first query must return ten rows; the second must list `workflow_hrc_run_maps`. If either is empty, restart acp-server (the `addColumnIfMissing` migrations only run on store open) and re-check.

### 0.5 Working scratch directory

```bash
RUN_ROOT=/tmp/hl-runbook-$(date +%Y%m%d-%H%M%S)
mkdir -p "$RUN_ROOT"
echo "RUN_ROOT=$RUN_ROOT"
```

Keep this shell open; every artifact ID, snapshot, and report goes under `$RUN_ROOT`.

### 0.6 Agents

Five live agents play roles below. Verify each is registered with ACP and has a runtime home:

```bash
acp agent list --json | jq -r '.agents[].agentId' | sort
ls /Users/lherron/praesidium/var/agents/ | grep -E '^(clod|cody|larry|rex|heather)$'
```

If `clod`, `cody`, or `larry` is missing from the ACP agent list, register:

```bash
acp agent create --agent clod  --display-name 'Clod'  --status active --home-dir /Users/lherron/praesidium/var/agents/clod
acp agent create --agent cody  --display-name 'Cody'  --status active --home-dir /Users/lherron/praesidium/var/agents/cody
acp agent create --agent larry --display-name 'Larry' --status active --home-dir /Users/lherron/praesidium/var/agents/larry
```

Role assignments used in this runbook (chosen so SoD constraints in §10 are satisfiable):

| Workflow role           | Live agent                    |
|-------------------------|-------------------------------|
| `learning_supervisor`   | `clod`                        |
| `trace_reviewer`        | `cody`                        |
| `correlation_steward`   | `heather`                     |
| `label_reviewer`        | `rex` (≠ trace_reviewer)      |
| `playbook_author`       | `cody`                        |
| `playbook_reviewer`     | `clod` (≠ playbook_author)    |
| `curator`               | `heather`                     |
| `patch_author`          | `cody`                        |
| `learning_auditor`      | `larry`                       |
| `evaluator_runner`      | `rex`                         |
| `evaluation_steward`    | `clod` (≠ patch_author)       |
| `promotion_reviewer`    | `larry` (≠ patch_author)      |
| `external_authority`    | `human:lherron`               |

### 0.7 Snapshot helper

`wlearn` reads `WorkflowKernelSnapshot` JSON. Drop this helper to disk once:

```bash
cat > "$RUN_ROOT/dump-snapshot.ts" <<'EOF'
import { writeFileSync } from 'node:fs'
import { openAcpStateStore } from 'acp-state-store'
const dbPath = process.env.ACP_STATE_DB ?? '/Users/lherron/praesidium/var/db/acp-state.db'
const out = process.argv[2] ?? '/tmp/acp-snapshot.json'
const store = openAcpStateStore({ dbPath })
const snap = store.workflowRuntime.loadSnapshot()
writeFileSync(out, JSON.stringify(snap, null, 2))
console.log(`wrote ${out} (events=${snap.events.length}, tasks=${snap.tasks.length}, maps=${snap.workflowHrcRunMaps?.length ?? 0})`)
EOF
```

The helper must live inside the workspace so Bun can resolve workspace
packages. To dump:

```bash
bun "$RUN_ROOT/dump-snapshot.ts" "$RUN_ROOT/snapshot.json"
```

---

## 1. MVP Step 1 — Event-source one workflow task

### 1.1 Execute — create a `code_defect_fastlane` task

Use a real workflow so we can drive a participant run with HRC backing.

```bash
TASK_ID="hl-mvp-$(date +%H%M%S)"
acp task create --json \
  --workflow code_defect_fastlane@1 \
  --project agent-spaces \
  --task-id "$TASK_ID" \
  --goal "MVP runbook: prove ACP event sourcing for a real task" \
  --supervisor clod \
  --supervisor-autonomy assist \
  --bind implementer=agent:cody \
  --bind tester=agent:rex \
  --as agent:clod \
  --idempotency-key "$TASK_ID-create" | tee "$RUN_ROOT/01-create.json"
```

Save the ID:

```bash
echo "$TASK_ID" > "$RUN_ROOT/TASK_ID"
```

### 1.2 Verify — the `task.created` event is event-sourced with the new schema

```bash
acp task show --task "$TASK_ID" --json \
  | jq '.events[] | select(.type=="task.created")
        | {type,workflowSeq,schemaVersion,result,commandType,commandHash,eventHash,prevHash,actor,role,authority,observedTaskVersion,nextTaskVersion}'
```

**Pass when:**

- `workflowSeq` ≥ 1 and is integer.
- `schemaVersion` ≥ 1.
- `result` is `"accepted"`.
- `commandType` and `commandHash` are non-empty.
- `eventHash` is a `sha256:...` string.
- `prevHash` is `null` (first event in this task's stream).
- `actor.id == "clod"` and `nextTaskVersion == 1`.

Sanity in the raw ledger (proves the event was persisted, not just projected):

```bash
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT workflow_seq, schema_version, type, result, command_type, substr(event_hash,1,15), prev_hash
   FROM workflow_events WHERE task_id = '$TASK_ID' ORDER BY workflow_seq;"
```

---

## 2. MVP Step 2 — Record one accepted and one rejected transition

### 2.1 Execute — produce the evidence the workflow needs

The `code_defect_fastlane` workflow needs implementer-produced evidence before a `red_to_green` (or equivalent) transition is legal. Have the live `cody` runtime attach evidence:

```bash
hrcchat dm cody@agent-spaces:$TASK_ID - <<EOF
You are the implementer for ACP task $TASK_ID. Run:

  acp task evidence add --json \\
    --task $TASK_ID \\
    --kind tdd_green_bundle \\
    --ref "memo:$TASK_ID/impl-1" \\
    --role implementer \\
    --summary "synthetic implementer evidence for HL runbook" \\
    --as agent:cody \\
    --idempotency-key $TASK_ID-impl-ev-1

Reply with the JSON output verbatim.
EOF
```

Wait for cody to reply, then capture the evidence ID from its message:

```bash
hrcchat messages | tail -50
```

If `code_defect_fastlane` requires a different evidence kind in your build, adjust `--kind` to whatever its `transitions.<id>.requires` declares (inspect with `grep -nE "kind|requires" packages/acp-core/src/presets/code_defect_fastlane.v1.ts`).

### 2.2 Execute — accepted transition

Have cody (the bound implementer) apply the transition:

```bash
hrcchat dm cody@agent-spaces:$TASK_ID - <<EOF
You are the implementer for ACP task $TASK_ID. Run:

  acp task transition --json \\
    --task $TASK_ID \\
    --transition red_to_green \\
    --role implementer \\
    --expected-version 0 \\
    --as agent:cody \\
    --idempotency-key $TASK_ID-trans-accept-1

Reply with the JSON output verbatim.
EOF
```

### 2.3 Execute — rejected transition

Force a deterministic rejection (stale-context). Run the transition with a stale `--expected-version` so the kernel must reject with `version_conflict`:

```bash
acp task transition --json \
  --task "$TASK_ID" \
  --transition red_to_green \
  --role supervisor \
  --expected-version 0 \
  --as agent:clod \
  --idempotency-key "$TASK_ID-trans-reject-1" \
  | tee "$RUN_ROOT/02-rejected.json" || true
```

(Non-zero exit is expected — the rejection itself is the artifact.)

### 2.4 Verify — both events are in the ledger with full envelopes

```bash
acp task show --task "$TASK_ID" --json \
  | jq '[.events[] | {seq:.workflowSeq, type, result, rejectionCode, commandType, eventHash:(.eventHash[:15]), prevHash:(.prevHash // null | tostring | .[:15])}] | sort_by(.seq)'
```

**Pass when:**

- At least one event has `result=="accepted"` and a non-null `prevHash` linking back.
- At least one event has `result=="rejected"` with `rejectionCode` set to one of: `version_conflict`, `stale_context`, `phase_mismatch`, `unknown_transition`, `missing_evidence`, `sod_violation`, `same_actor_sod_violation` (whichever fires first for your forced bad command).
- Every event has a non-empty `eventHash`. Hash chain holds: each event's `prevHash` equals the `eventHash` of the event whose `workflowSeq` is one less.

Hash-chain check:

```bash
acp task show --task "$TASK_ID" --json \
  | jq -r '.events | sort_by(.workflowSeq)[] | "\(.workflowSeq)\t\(.eventHash)\t\(.prevHash // "")"' \
  | awk -F'\t' 'NR==1{prev=$2;next} {if($3!=prev){print "BROKEN at seq "$1; exit 1} prev=$2} END{print "chain OK"}'
```

**Pass when:** prints `chain OK`.

---

## 3. MVP Step 3 — Record one HRC participant mapping

### 3.1 Execute — launch a participant run with HRC identity bound

```bash
acp task run --json \
  --task "$TASK_ID" \
  --role implementer \
  --agent cody \
  --harness '{"kind":"clod","hrcRunId":"hrcrun-smoke-1","scopeRef":"cody@agent-spaces:'"$TASK_ID"'","laneRef":"main"}' \
  --runtime-id rt-smoke-1 \
  --host-session-id hsess-smoke-1 \
  --idempotency-key "$TASK_ID-run-1" \
  --as agent:cody \
  | tee "$RUN_ROOT/03-run.json"
RUN_ID=$(jq -r '.participantRun.runId // .run.runId // .runId // .run.run.runId' "$RUN_ROOT/03-run.json")
echo "RUN_ID=$RUN_ID"
```

If `--harness` shape is rejected, use the explicit flags instead:
`--hrc-run-id`, `--runtime-id`, `--launch-id`, `--host-session-id`,
`--scope-ref`, and `--lane-ref`. A `workflow_hrc_run_maps` row requires an
HRC run id; scope/lane alone are not a complete ACP/HRC run mapping.

### 3.2 Verify — `WorkflowHrcRunMap` row exists

```bash
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT map_id, workflow_task_id, participant_run_id, hrc_run_id, scope_ref, lane_ref, source, created_at
   FROM workflow_hrc_run_maps WHERE workflow_task_id = '$TASK_ID';"
```

**Pass when:** at least one row exists with `source='launch'` (or `'admission'`), the `participant_run_id` matches `$RUN_ID`, and at least one HRC identity field is non-null.

Cross-check the projection:

```bash
acp task show --task "$TASK_ID" --json | jq '.workflowHrcRunMaps // []'
```

---

## 4. MVP Step 4 — HRC provides the run/turn/tool range

### 4.1 Execute — let the live agent actually do something

```bash
hrcchat dm cody@agent-spaces:$TASK_ID - <<EOF
For ACP task $TASK_ID participant run $RUN_ID, run a single shell command that lists the current directory, then reply 'done'.
EOF
```

Give it a few seconds; the runtime will record turns, tool calls, and exec events.

### 4.2 Verify — HRC has a populated event range under the bound scope

```bash
hrc monitor show "cody@agent-spaces:$TASK_ID" 2>&1 | tail -40
```

Or directly from the HRC store:

```bash
sqlite3 /Users/lherron/praesidium/var/db/hrc.db \
  "SELECT type, COUNT(*) FROM events WHERE scope_ref = 'cody@agent-spaces:$TASK_ID' GROUP BY type ORDER BY 2 DESC;" 2>/dev/null \
  || sqlite3 /Users/lherron/praesidium/var/state/hrc.db \
       "SELECT type, COUNT(*) FROM events WHERE scope_ref = 'cody@agent-spaces:$TASK_ID' GROUP BY type ORDER BY 2 DESC;"
```

**Pass when:** counts include at least `turn.*`, `tool_call.*` or `exec.*`, and runtime lifecycle events.

Capture the seq range for §5:

```bash
sqlite3 /Users/lherron/praesidium/var/db/hrc.db \
  "SELECT MIN(seq), MAX(seq) FROM events WHERE scope_ref = 'cody@agent-spaces:$TASK_ID';" \
  | tee "$RUN_ROOT/04-hrc-range.txt"
```

### 4.3 Execute — close the participant run cleanly

```bash
acp task run-complete --json \
  --run "$RUN_ID" \
  --outcome completed \
  --as agent:cody \
  --idempotency-key "$TASK_ID-run-complete-1" \
  | tee "$RUN_ROOT/04-run-complete.json"
```

---

## 5. MVP Step 5 — `wlearn` materializes one trace

### 5.1 Execute — dump the snapshot and materialize

```bash
bun "$RUN_ROOT/dump-snapshot.ts" "$RUN_ROOT/snapshot.json"
wlearn trace materialize --snapshot "$RUN_ROOT/snapshot.json" --task "$TASK_ID" \
  | tee "$RUN_ROOT/05-trace.json"
```

### 5.2 Verify — the trace has a clean correlation state

```bash
jq '{traceId, workflowTaskId, workflow, workflowSeqRange, hrcRanges, correlation, metrics}' "$RUN_ROOT/05-trace.json"
```

**Pass when:**

- `correlation.state` is `"fully_correlated"` (or `"partially_correlated"` with `missingKeys` listing only optional fields).
- `workflowSeqRange[0] == 1` and `workflowSeqRange[1]` ≥ 3.
- `hrcRanges` has ≥ 1 entry pointing at the participant run from §4.
- `metrics.transitionsAccepted ≥ 1` and `metrics.transitionsRejected ≥ 1`.

Save the trace ID:

```bash
TRACE_ID=$(jq -r '.traceId' "$RUN_ROOT/05-trace.json")
echo "TRACE_ID=$TRACE_ID"
```

---

## 6. MVP Step 6 — Deterministic workflow replay

### 6.1 Execute

```bash
wlearn replay run --snapshot "$RUN_ROOT/snapshot.json" --task "$TASK_ID" \
  | tee "$RUN_ROOT/06-replay.json"
```

### 6.2 Verify

```bash
jq '{outcome, evaluatorVersion, results: [.results[] | {traceId, outcome, failedProperties}]}' "$RUN_ROOT/06-replay.json"
```

**Pass when:** every `results[].outcome == "passed"`, and
`failedProperties` is empty for each entry. The current CLI may leave the
top-level `outcome` null; trust the per-result outcomes. This proves
event-hash integrity, hash-chain continuity, and that recorded rejections still
rejection-match their codes.

Counterfactual sanity (optional but recommended): hand-edit one `eventHash`
byte in the snapshot and re-run — at least one replay result must come back
`"failed"`.

```bash
cp "$RUN_ROOT/snapshot.json" "$RUN_ROOT/snapshot.tampered.json"
python3 -c "import json,sys
p='$RUN_ROOT/snapshot.tampered.json'
d=json.load(open(p))
e=d['events'][0]
e['eventHash']='sha256:' + ('0'*64)
json.dump(d,open(p,'w'),indent=2)"
wlearn replay run --snapshot "$RUN_ROOT/snapshot.tampered.json" --task "$TASK_ID" \
  | jq '[.results[] | {outcome, failedProperties}]'
```

**Pass when:** the tampered run prints `"failed"`.

---

## 7. MVP Step 7 — `learning_trace_triage` reviews the trace (live agents)

### 7.1 Execute — create the triage task

```bash
TRIAGE_TASK="hl-triage-$(date +%H%M%S)"
acp task create --json \
  --workflow learning_trace_triage@1 \
  --project agent-spaces \
  --task-id "$TRIAGE_TASK" \
  --goal "Triage trace $TRACE_ID from $TASK_ID" \
  --supervisor clod \
  --supervisor-autonomy assist \
  --bind learning_supervisor=agent:clod \
  --bind trace_reviewer=agent:cody \
  --bind correlation_steward=agent:heather \
  --as agent:clod \
  --idempotency-key "$TRIAGE_TASK-create" \
  | tee "$RUN_ROOT/07-triage-create.json"
```

### 7.2 Execute — attach the trigger, ingest report, and materialize

```bash
acp task evidence add --task "$TRIAGE_TASK" --kind learning_trigger \
  --ref "memo:$TASK_ID/trigger-mvp" --role learning_supervisor \
  --summary "MVP runbook: rejected transition observed in $TASK_ID" \
  --as agent:clod --idempotency-key "$TRIAGE_TASK-ev-trigger" --json

acp task evidence add --task "$TRIAGE_TASK" --kind trace_ingest_report \
  --ref "file://$RUN_ROOT/05-trace.json" --role learning_supervisor \
  --summary "fully_correlated trace $TRACE_ID" \
  --as agent:clod --idempotency-key "$TRIAGE_TASK-ev-ingest" --json

acp task transition --task "$TRIAGE_TASK" --transition materialize_trace \
  --role learning_supervisor --as agent:clod \
  --idempotency-key "$TRIAGE_TASK-trans-materialize" --json
```

### 7.3 Execute — dispatch the trace_reviewer (cody) to assess and classify

```bash
hrcchat dm cody@agent-spaces:$TRIAGE_TASK - <<EOF
You are trace_reviewer for ACP task $TRIAGE_TASK. Read $RUN_ROOT/05-trace.json.
1) Attach trace_assessment evidence:
   acp task evidence add --task $TRIAGE_TASK --kind trace_assessment \\
     --ref "memo:$TRACE_ID/assessment" --role trace_reviewer \\
     --summary "<your one-sentence assessment>" \\
     --as agent:cody --idempotency-key $TRIAGE_TASK-ev-assess --json
2) Apply review_trace transition as cody.
3) Reply with the JSON output of both commands.
EOF
```

Let clod close it as a playbook candidate:

```bash
acp task evidence add --task "$TRIAGE_TASK" --kind failure_classification \
  --ref "memo:$TRACE_ID/classification" --role learning_supervisor \
  --summary "rejected transition under stale context — playbook candidate" \
  --as agent:clod --idempotency-key "$TRIAGE_TASK-ev-classify" --json

acp task transition --task "$TRIAGE_TASK" --transition classify_trace \
  --role learning_supervisor --as agent:clod \
  --idempotency-key "$TRIAGE_TASK-trans-classify" --json

acp task transition --task "$TRIAGE_TASK" --transition create_playbook_candidate \
  --role learning_supervisor --as agent:clod \
  --idempotency-key "$TRIAGE_TASK-trans-pbcand" --json
```

### 7.4 Verify

```bash
acp task show --task "$TRIAGE_TASK" --json \
  | jq '{status:.task.status, phase:.task.phase, outcome:.task.outcome, eventCount:(.events|length), rejected:[.events[]|select(.result=="rejected")|.rejectionCode]}'
```

**Pass when:** `status=="closed"`, `outcome=="playbook_candidate"`, `eventCount` ≥ 5, and every accepted transition was made by an actor with the legal role.

---

## 8. MVP Step 8 — `learning_playbook_update` activates one low-authority playbook

Validates SoD: `playbook_reviewer` must differ from `playbook_author`.

### 8.1 Execute — create the playbook task and draft

```bash
PB_TASK="hl-playbook-$(date +%H%M%S)"
acp task create --json \
  --workflow learning_playbook_update@1 \
  --project agent-spaces \
  --task-id "$PB_TASK" \
  --goal "Activate playbook for $TRACE_ID stale-context failure mode" \
  --supervisor clod --supervisor-autonomy assist \
  --bind learning_supervisor=agent:clod \
  --bind playbook_author=agent:cody \
  --bind playbook_reviewer=agent:clod \
  --as agent:clod --idempotency-key "$PB_TASK-create" \
  | tee "$RUN_ROOT/08-pb-create.json"
```

Have cody draft (real agent producing a playbook artifact):

```bash
hrcchat dm cody@agent-spaces:$PB_TASK - <<EOF
You are playbook_author for ACP task $PB_TASK. Use:
  wlearn playbook draft --trace $TRACE_ID
…then attach as evidence:
  acp task evidence add --task $PB_TASK --kind playbook_draft \\
    --ref "memo:$TRACE_ID/playbook-draft" --role playbook_author \\
    --summary "<one-sentence guidance scope>" \\
    --as agent:cody --idempotency-key $PB_TASK-ev-draft --json
Reply with the wlearn output and the evidence JSON.
EOF
```

### 8.2 Execute — playbook_reviewer (clod) reviews and activates

```bash
acp task evidence add --task "$PB_TASK" --kind playbook_review \
  --ref "memo:$TRACE_ID/playbook-review" --role playbook_reviewer \
  --summary "scope is explicit; does not contradict workflow law; approve activation" \
  --as agent:clod --idempotency-key "$PB_TASK-ev-review" --json

acp task transition --task "$PB_TASK" --transition review_playbook \
  --role playbook_reviewer --as agent:clod \
  --idempotency-key "$PB_TASK-trans-review" --json

acp task transition --task "$PB_TASK" --transition activate_playbook \
  --role playbook_reviewer --as agent:clod \
  --idempotency-key "$PB_TASK-trans-activate" --json
```

### 8.3 Verify SoD enforcement

Force a violation on a fresh SoD task where the same actor is deliberately
bound to both `playbook_author` and `playbook_reviewer`, then try to review as
that actor. If cody is not bound to the reviewer role, an earlier
`role_not_bound` rejection is expected instead of a pure SoD rejection.

```bash
acp task transition --json --task "$PB_TASK" --transition review_playbook \
  --role playbook_reviewer --as agent:cody \
  --idempotency-key "$PB_TASK-trans-review-bad" || true
```

**Pass when:** that command's response shows `result=="rejected"` with
`rejectionCode=="sod_violation"` or an equivalent same-actor SoD code, and the
projection still shows the original accepted activation:

```bash
acp task show --task "$PB_TASK" --json \
  | jq '{status:.task.status, outcome:.task.outcome,
         rejections:[.events[]|select(.result=="rejected")|{type, rejectionCode, actor:.actor.id}]}'
```

`status=="closed"`, `outcome=="active"`, and the rejected attempt is recorded.

---

## 9. MVP Step 9 — `learning_policy_patch` drafts a high-authority patch (no promotion)

### 9.1 Execute — create the policy patch task

```bash
PP_TASK="hl-policypatch-$(date +%H%M%S)"
acp task create --json \
  --workflow learning_policy_patch@1 \
  --project agent-spaces \
  --task-id "$PP_TASK" \
  --goal "Draft governed patch bundle for stale-context failure mode" \
  --supervisor clod --supervisor-autonomy assist \
  --bind learning_supervisor=agent:clod \
  --bind patch_author=agent:cody \
  --bind learning_auditor=agent:larry \
  --bind evaluation_steward=agent:clod \
  --bind evaluator_runner=agent:rex \
  --as agent:clod --idempotency-key "$PP_TASK-create" \
  | tee "$RUN_ROOT/09-pp-create.json"
```

### 9.2 Execute — patch_author (cody) drafts the bundle

```bash
hrcchat dm cody@agent-spaces:$PP_TASK - <<EOF
You are patch_author for ACP task $PP_TASK. Use:
  wlearn patch draft --trace $TRACE_ID --target transitionRequirementChanges
…then attach as evidence:
  acp task evidence add --task $PP_TASK --kind patch_bundle \\
    --ref "memo:$TRACE_ID/patch-bundle-1" --role patch_author \\
    --summary "Tighten stale-context guard for code_defect_fastlane" \\
    --as agent:cody --idempotency-key $PP_TASK-ev-pb --json
…then apply draft_patch_bundle:
  acp task transition --task $PP_TASK --transition draft_patch_bundle \\
    --role patch_author --as agent:cody \\
    --idempotency-key $PP_TASK-trans-draft --json
Reply with all three outputs.
EOF
```

### 9.3 Execute — risk review and replay-prep

```bash
acp task evidence add --task "$PP_TASK" --kind risk_review \
  --ref "memo:$TRACE_ID/risk-review" --role evaluation_steward \
  --summary "no requirement weakening; no capability expansion" \
  --as agent:clod --idempotency-key "$PP_TASK-ev-risk" --json

acp task transition --task "$PP_TASK" --transition review_risk \
  --role evaluation_steward --as agent:clod \
  --idempotency-key "$PP_TASK-trans-risk" --json

acp task evidence add --task "$PP_TASK" --kind replay_report \
  --ref "file://$RUN_ROOT/06-replay.json" --role evaluator_runner \
  --summary "deterministic replay passed against trace $TRACE_ID" \
  --as agent:rex --idempotency-key "$PP_TASK-ev-replay" --json

acp task transition --task "$PP_TASK" --transition prepare_replay \
  --role evaluator_runner --as agent:rex \
  --idempotency-key "$PP_TASK-trans-replay" --json
```

### 9.4 Execute — request evaluation (NOT promotion)

```bash
acp task transition --task "$PP_TASK" --transition request_evaluation \
  --role evaluation_steward --as agent:clod \
  --idempotency-key "$PP_TASK-trans-reqeval" --json
```

### 9.5 Verify — patch is drafted and evaluation-requested, **never promoted**

```bash
acp task show --task "$PP_TASK" --json \
  | jq '{status:.task.status, phase:.task.phase, outcome:.task.outcome,
         evidenceKinds:[.evidence[].kind]|unique,
         transitions:[.events[]|select(.commandType=="apply_transition")|{seq:.workflowSeq, type, result, rejectionCode}]}'
```

**Pass when:** `outcome=="evaluation_requested"`, evidence kinds include `patch_bundle`, `risk_review`, `replay_report`, and **no** event of type `patch.promoted` exists in the projection (`jq '.events[]|select(.type|test("promot"))'` returns empty).

### 9.6 Negative check — confirm `wlearn` cannot self-promote

```bash
wlearn promotion submit \
  --patch-bundle-json '{"patchBundleId":"pb-mvp","title":"t","hypothesis":"h","sourceTraceIds":["'"$TRACE_ID"'"],"sourceEventIds":[],"facets":{},"risk":{"changesAuthority":false,"weakensRequirement":false,"expandsCapability":false,"changesEvaluator":false,"changesTaskTaxonomy":false,"suppressesOrReclassifiesAnomalies":false},"evalPlan":{"replayTraceIds":["'"$TRACE_ID"'"],"regressionSuiteIds":[],"counterfactualSuiteIds":[],"requiredInvariants":[]},"rollbackPlan":"revert by reverting the patch","author":{"kind":"agent","id":"cody"},"createdAt":"2026-05-11T00:00:00Z"}' \
  --replay-report rep-1 --eval-report ev-1 \
  --reviewer agent:larry \
  | tee "$RUN_ROOT/09-promotion-readiness.json"
```

**Pass when:** the output's `acpAction` is `"promotion_requested"` (a *request*, not a state change), `report.recommendation` is `"reject"` or `"request_more_evidence"` (no external_authority was supplied for any high-risk facet), and **nothing** in `acp task show --task $PP_TASK --json` advances to a `promoted` outcome.

---

## 10. Cross-cutting ledger validation

Run after §1–§9 are green. These confirm the structural invariants from spec §3 and §12.

### 10.1 Every accepted policy command emitted an event

```bash
for T in "$TASK_ID" "$TRIAGE_TASK" "$PB_TASK" "$PP_TASK"; do
  echo "=== $T ==="
  acp task show --task "$T" --json \
    | jq '[.events[] | {seq:.workflowSeq, type, result, rc:.rejectionCode}] | sort_by(.seq)'
done
```

**Pass when:** every accepted transition shown in `task.phase` history has a corresponding `result=="accepted"` event, and every forced bad command has a `result=="rejected"` event with a populated `rejectionCode`.

### 10.2 Effect lifecycle is ledgered (no silent unsupported)

```bash
acp task show --task "$TASK_ID" --json \
  | jq '{effects:[.effects[]|{effectId, kind, status, deliveryResult, errorCode}],
         effectEvents:[.events[]|select(.type|startswith("effect."))|{seq:.workflowSeq, type, payload:.payload}]}'
```

**Pass when:** for every effect in `effects`, there is at least one corresponding `effect.intent.created` event and a terminal `effect.intent.delivered`, `effect.intent.failed`, `effect.intent.unsupported`, or `effect.intent.expired` event. **No** unsupported effect appears as `delivered`.

### 10.3 ACP↔HRC mappings are written at launch, not derived

```bash
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT source, COUNT(*) FROM workflow_hrc_run_maps GROUP BY source;"
```

**Pass when:** `launch` and/or `admission` rows exist; `reconciled` rows are not the only source.

### 10.4 SoD violations are visible in the ledger

```bash
acp task show --task "$PB_TASK" --json \
  | jq '[.events[]|select(.rejectionCode=="sod_violation" or .rejectionCode=="same_actor_sod_violation" or .rejectionCode=="role_authority_violation")|{seq:.workflowSeq, type, actor, rejectionCode}]'
```

**Pass when:** the SoD rejection from §8.3 is present.

### 10.5 Hash chain is complete across all tasks

```bash
for T in "$TASK_ID" "$TRIAGE_TASK" "$PB_TASK" "$PP_TASK"; do
  acp task show --task "$T" --json \
    | jq -r --arg t "$T" '.events|sort_by(.workflowSeq)|.[]|"\($t)\t\(.workflowSeq)\t\(.eventHash)\t\(.prevHash // "")"'
done | awk -F'\t' '
  { if (last[$1] != "" && $4 != last[$1]) { print "BROKEN " $1 " seq " $2; bad++ }
    last[$1] = $3 }
  END { if (bad) exit 1; print "all chains OK" }'
```

**Pass when:** prints `all chains OK`.

### 10.6 Replay over the full snapshot still passes

```bash
bun "$RUN_ROOT/dump-snapshot.ts" "$RUN_ROOT/snapshot-final.json"
for T in "$TASK_ID" "$TRIAGE_TASK" "$PB_TASK" "$PP_TASK"; do
  echo "=== replay $T ==="
  wlearn replay run --snapshot "$RUN_ROOT/snapshot-final.json" --task "$T" | jq '{outcome, failed:[.results[]|select(.outcome!="passed")]}'
done
```

**Pass when:** every task's replay outcome is `"passed"` and `failed` is empty.

### 10.7 Goodhart guards — learner cannot mutate its own success signal

Confirm `wlearn` exposes no lifecycle/promotion/evaluator-mutation surface:

```bash
wlearn help 2>&1 | grep -iE 'promote|mutate|evaluator (set|edit)|trust|label (set|accept)|delete'
```

**Pass when:** no matches (only `promotion submit` exists, which is a *request submission*, not an authority change).

---

## 11. Acceptance summary

The runbook passes when **all** of the following are true:

- [ ] §1.2 — `task.created` event has the full new envelope (workflowSeq, schemaVersion, commandHash, eventHash, result, actor/role/authority).
- [ ] §2.4 — at least one accepted and one rejected transition are ledgered with rejection code; hash chain validates.
- [ ] §3.2 — `workflow_hrc_run_maps` has a `launch`/`admission` row tying the participant run to HRC identity.
- [ ] §4.2 — HRC has turn/tool/exec events under the bound scope ref.
- [ ] §5.2 — `wlearn trace materialize` returns `correlation.state == "fully_correlated"` (or partial with only optional missingKeys).
- [ ] §6.2 — `wlearn replay run` returns `results[].outcome == "passed"`; tampered snapshot returns failed per-result outcomes.
- [ ] §7.4 — `learning_trace_triage` task closes as `playbook_candidate` with all required evidence kinds attached.
- [ ] §8.3 — `learning_playbook_update` activates the playbook **and** the SoD-violating attempt is recorded as a rejection.
- [ ] §9.5 — `learning_policy_patch` reaches `evaluation_requested`; no `patch.promoted` event exists anywhere.
- [ ] §9.6 — `wlearn promotion submit` only produces a *readiness report* with `acpAction: "promotion_requested"`; no state change occurs.
- [ ] §10.1–§10.7 — all cross-cutting checks pass.

Archive `$RUN_ROOT` for the audit trail:

```bash
tar czf "$RUN_ROOT.tar.gz" -C "$(dirname "$RUN_ROOT")" "$(basename "$RUN_ROOT")"
echo "evidence bundle: $RUN_ROOT.tar.gz"
```

---

## 12. Common breakage and triage

| Symptom | Likely cause | Fix |
|---|---|---|
| `acp task show` events have no `workflowSeq`/`eventHash` | acp-server running pre-Phase-1 build | `stackctl restart dev`; confirm §0.4 returns 10 columns |
| `workflow_hrc_run_maps` empty after §3 | missing HRC run id, stale acp-cli, stale acp-server, or participant-runs route ignored launch identity | Include `hrcRunId` in `--harness` JSON or pass `--hrc-run-id`; run `just install` if CLI flags are stale; restart ACP if `acp task show` does not project a row that exists in `/Users/lherron/praesidium/var/db/acp-state.db` |
| `wlearn trace materialize` returns `correlation.state == "malformed"` | snapshot dump pre-dates the participant run, or HRC store path mismatch | Re-dump snapshot **after** §4; confirm `ACP_STATE_DB` and HRC db paths match `stackctl status dev` |
| Replay fails with `eventHash mismatch` on untampered snapshot | event was written before hash columns existed | Discard and create a fresh task in §1 |
| SoD test in §8.3 *succeeds* | SoD requirement missing or the tested transition did not require author/reviewer separation | Confirm the workflow transition declares the SoD requirement and bind the same actor to both roles only for the negative test |
| `wlearn promotion submit` returns `recommendation: "promote"` | high-risk facet declared with no `--external-authority` flag | Expected only when `risk.*` are all false; verify no high-risk facet was declared |

---

## Appendix A — Workflow ↔ evidence cheat sheet

Source: `packages/acp-core/src/workflow/definitions.ts`.

| Workflow                       | Required evidence kinds (sample)                                  | SoD constraints                                       |
|--------------------------------|-------------------------------------------------------------------|-------------------------------------------------------|
| `learning_trace_triage`        | `learning_trigger`, `trace_ingest_report`, `trace_assessment`, `failure_classification`, `no_op_report` | none                                                  |
| `learning_trace_labeling`      | `trace_label`, `label_review`                                     | `label_reviewer ≠ trace_reviewer`                     |
| `learning_playbook_update`     | `playbook_draft`, `playbook_review`, `curation_report`            | `playbook_reviewer ≠ playbook_author`                 |
| `learning_curation`            | `curation_report`                                                 | `playbook_reviewer ≠ curator`                         |
| `learning_policy_patch`        | `patch_bundle`, `risk_review`, `replay_report`                    | `evaluation_steward ≠ patch_author`                   |
| `learning_patch_evaluation`    | `replay_report`, `eval_report`                                    | `evaluation_steward ≠ patch_author`                   |
| `learning_patch_promotion`     | `patch_bundle`, `replay_report`, `eval_report`, `promotion_readiness_report` | `promotion_reviewer ≠ patch_author`           |
| `learning_patch_rollback`      | `rollback_plan`                                                   | enforced by promotion-reviewer authority              |
| `learning_workflow_patch`      | `meta_eval_report`, `external_authority_approval`                 | future-version only                                   |

## Appendix B — Useful one-liners

```bash
# Tail a task's events as they arrive
watch -n2 "acp task show --task $TASK_ID --json | jq '[.events[]|{seq:.workflowSeq,type,result,rc:.rejectionCode}]|sort_by(.seq)|.[-10:]'"

# All rejection codes seen in the DB
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT rejection_code, COUNT(*) FROM workflow_events WHERE rejection_code IS NOT NULL GROUP BY rejection_code ORDER BY 2 DESC;"

# Effect outcomes seen
sqlite3 /Users/lherron/praesidium/var/db/acp-state.db \
  "SELECT json_extract(payload_json,'$.deliveryResult'), COUNT(*)
   FROM workflow_events WHERE type LIKE 'effect.intent.%' GROUP BY 1 ORDER BY 2 DESC;"
```
