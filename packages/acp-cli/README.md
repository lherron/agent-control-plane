# acp-cli

User-facing ACP CLI for ACP admin, runtime, coordination, tasks, jobs, deliveries, and conversation inspection through `acp-server`.

Start `acp-server` locally first, then point the CLI at it (or rely on the default URL).

## Commands

- `acp runtime resolve`
- `acp session resolve|list|show|runs|reset|interrupt|capture|attach-command`
- `acp run show|cancel`
- `acp send`
- `acp tail`
- `acp render`
- `acp message send|broadcast`
- `acp job create|list|show|patch|run`
- `acp job-run list|show`
- `acp heartbeat set|wake`
- `acp delivery retry|list-failed`
- `acp thread list|show|turns`
- `acp task create`
- `acp task show`
- `acp task transition`
- `acp task evidence add`
- `acp task obligation waive`
- `acp task obligation cancel`
- `acp task run` *(implemented but not yet wired into CLI dispatch — use HTTP API directly)*
- `acp workflow supervise`
- `acp workflow supervisor-context`
- `acp workflow action`
- `acp workflow patch list`
- `acp workflow patch show`
- `acp supervise` (alias for `workflow supervise`)

## Workflow task commands

### `acp task evidence add` (E1 — standalone evidence attach)

Attach evidence to a workflow task with provenance tracking. Three
authorization sources are supported: role-bound actor, supervisor, or
participant run.

```bash
acp task evidence add \
  --task <taskId> \
  --kind <evidenceKind> \
  --ref <evidenceRef> \
  --idempotency-key <key> \
  [--role <role>] \
  [--run-id <runId>] \
  [--supervisor-run-id <supervisorRunId>] \
  [--participant-run-id <participantRunId>] \
  [--actor <agentId>] \
  [--json]
```

**Required:** `--task`, `--kind`, `--ref`, `--idempotency-key`.

The `--actor` flag (or `ACP_ACTOR_AGENT_ID` env) sets the actor identity.
Provenance is recorded via `--role`, `--run-id`, `--supervisor-run-id`, or
`--participant-run-id`.

Example — attach as role-bound actor:
```bash
acp task evidence add \
  --task T-001 --kind commit_ref --ref git:abc123 \
  --actor larry --role implementer \
  --idempotency-key ev:commit:v1
```

Example — attach via participant run:
```bash
acp task evidence add \
  --task T-001 --kind regression_test --ref test:checkout.repro \
  --actor larry --participant-run-id prun_001 \
  --idempotency-key ev:test:v1
```

### `acp task obligation waive` (E2 — waive obligation)

Waive a blocking obligation with a reason and optional evidence references.
Produces a waiver record that the kernel matches against
`Requirement{type:'waiver'}` on subsequent transitions.

```bash
acp task obligation waive \
  --task <taskId> \
  --obligation <obligationId> \
  --reason <text> \
  --idempotency-key <key> \
  [--evidence-ref <ref>]... \
  [--actor <agentId>] \
  [--json]
```

**Required:** `--task`, `--obligation`, `--reason`, `--idempotency-key`.

The `--evidence-ref` flag can be repeated to attach multiple evidence
references to the waiver.

Example:
```bash
acp task obligation waive \
  --task T-001 --obligation obl_audit_signoff \
  --reason "Low-risk change covered by policy" \
  --evidence-ref evd_waiver_doc \
  --actor rex --idempotency-key obl:waive:v1
```

### `acp task obligation cancel` (E2 — cancel obligation)

Cancel (supersede) an obligation. Cancellation does NOT satisfy waiver
requirements — use `waive` when waiver semantics are needed.

```bash
acp task obligation cancel \
  --task <taskId> \
  --obligation <obligationId> \
  --reason <text> \
  --idempotency-key <key> \
  [--actor <agentId>] \
  [--json]
```

**Required:** `--task`, `--obligation`, `--reason`, `--idempotency-key`.

Example:
```bash
acp task obligation cancel \
  --task T-001 --obligation obl_auto_cleanup \
  --reason "Superseded by direct cleanup pipeline run." \
  --actor rex --idempotency-key obl:cancel:v1
```

### `acp task run` (G — participant runtime)

> **Note:** The command implementation (`task-run.ts`) exists and is tested
> but is not yet wired into the CLI dispatch tree. Use the HTTP API
> (`POST /v1/workflow-participant-runs`) directly for now.

Launch or resume a participant run. The kernel rejects requests where the
actor does not match the persisted role binding (`role_not_bound`).

CLI flags (once wired):

```bash
acp task run \
  --task <taskId> \
  --role <role> \
  --agent <agentId> \
  [--harness <harnessKind>] \
  [--idempotency-key <key>] \
  [--resume] \
  [--json]
```

**Required:** `--task`, `--role`, `--agent`.

The `--resume` flag resumes an existing run instead of creating a new one.

HTTP API example:

```bash
curl -s -X POST http://127.0.0.1:18470/v1/workflow-participant-runs \
  -H 'content-type: application/json' \
  -H 'x-acp-actor-agent-id: larry' \
  -d '{
    "taskId": "T-001",
    "role": "implementer",
    "actor": {"kind":"agent","id":"larry"},
    "harness": {"kind":"codex"},
    "idempotencyKey": "run:launch:v1"
  }'
```

Completing and failing participant runs is also done via the HTTP API
directly (`POST /v1/workflow-participant-runs/:runId/complete` and
`POST /v1/workflow-participant-runs/:runId/fail`). No CLI wrappers exist
for these endpoints yet.

### `acp workflow action` (H — supervisor control actions)

Submit a supervisor control action. Capabilities are derived from the
persisted supervisor run record — the `--capabilities` flag is accepted for
backwards compatibility but its value is **ignored** (auth hardening).

Starting a supervisor run via `acp workflow supervise` or
`POST /v1/workflow-supervisor-runs` is a **hard prerequisite** for any
control action.

```bash
acp workflow action \
  --task <taskId> \
  --supervisor-run <supervisorRunId> \
  --action '<json>' \
  --idempotency-key <key> \
  [--expected-version <n>] \
  [--context-hash <hash>] \
  [--capabilities <json>] \
  [--actor <agentId>] \
  [--json]
```

**Required:** `--task`, `--supervisor-run`, `--action`, `--idempotency-key`.

Action type JSON examples:

```bash
# attach_evidence — supervisor attaches evidence records
--action '{"type":"attach_evidence","evidence":[{"kind":"note","ref":"doc:x","summary":"..."}]}'

# apply_transition — supervisor applies transition backed by participant evidence
--action '{"type":"apply_transition","transitionId":"implement_fix","evidenceRefs":["evd_001","evd_002"]}'

# escalate — record an escalation anomaly
--action '{"type":"escalate","reason":"Blocked on external dependency","severity":"high"}'

# launch_participant_run — launch a participant for a bound role
--action '{"type":"launch_participant_run","role":"implementer","actor":{"kind":"agent","id":"larry"}}'

# satisfy_obligation — satisfy a blocking obligation
--action '{"type":"satisfy_obligation","obligationKind":"reviewer_signoff_pending","evidenceRefs":["evd_review"]}'

# pause_supervision — pause supervisor run; further actions return supervisor_paused
--action '{"type":"pause_supervision","reason":"Manual reviewer break"}'

# unpause_supervision — resume a paused supervisor run
--action '{"type":"unpause_supervision"}'
```

### `acp workflow patch list` / `acp workflow patch show` (I — patch proposals)

List and inspect workflow patch proposals for a task.

```bash
# List proposals
acp workflow patch list \
  --task <taskId> \
  [--status <status>] \
  [--limit <n>]

# Show a single proposal
acp workflow patch show <proposalId> \
  [--raw] \
  [--json]
```

`patch list` returns proposal summaries. `patch show` returns the full
proposal including `patch` and `replayExpectations` payloads; use `--raw` or
`--json` for the full record.

## Environment

- `ACP_SERVER_URL` — overrides the server base URL. Default: `http://127.0.0.1:18470` (`acp-server`)
- `ACP_ACTOR_AGENT_ID` — fallback actor id for write commands when `--actor` is omitted

## Notes

- Commands return JSON by default. Pass `--table` on the new runtime / coordination / jobs / thread commands for compact tabular output.
- `acp heartbeat set` upserts an agent heartbeat and `acp heartbeat wake` triggers the matching admin wake route.
- `--json` prints the parsed response body as JSON.
- Legacy `task promote` and `task transitions` commands were removed as breaking changes when the workflow task surface migrated to kernel semantics.
