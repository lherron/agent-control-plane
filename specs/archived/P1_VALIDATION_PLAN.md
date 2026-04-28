# ACP P1 Manual E2E Validation Plan

Status date: 2026-04-23
Scope: P1 items claimed delivered in `IMPLEMENTATION_GAPS.md` (P1.1a, P1.1c, P1.2, P1.3, P1.4, P1.5, P1.6, P1.7, P1.8). P0 and P2 are out of scope.

Driver: `clod@agent-spaces` (coordinator).
Tooling: the `acp` CLI on PATH (`/Users/lherron/.bun/bin/acp`) + `curl` for raw HTTP probes when CLI coverage is missing.
Fix dispatch: `hrcchat dm <agent>@agent-spaces:T-XXXXX` to `cody` (available, summoned). `larry`/`curly` are currently busy.

Server under test: `bun packages/acp-cli/src/cli.ts server serve` (pid 19815, uptime 15:26 at 2026-04-23).
Base URL: `http://127.0.0.1:18470`.

---

## Pre-flight observations (raw HTTP probes)

| Endpoint | Method | Observed | Expected per gap doc |
|---|---|---|---|
| `/v1/admin/agents` | GET | 200 | 200 (P1.1a) |
| `/v1/admin/projects` | GET | 200 | 200 (P1.1a) |
| `/v1/admin/system-events` | GET | 200 | 200 (P1.1a) |
| `/v1/admin/memberships` | GET | 404; POST 400 | GET should list (P1.1a) |
| `/v1/admin/interface-identities` | GET | 404; POST 400 | GET should list (P1.1a) |
| `/v1/admin/jobs` | GET | 500 | 200 list (P1.2) |
| `/v1/admin/jobs/:id/run` | POST | untested | 200 (P1.2) |
| `/v1/jobs/:id/runs` | GET | 500 on bad id | 404 on missing, 200 on real |
| `/v1/admin/agents/:id/heartbeat` | PUT | 404 on unknown id | 200 (P1.1c) |
| `/v1/agents/:id/heartbeat/wake` | POST | 404 on unknown id | 200 (P1.1c) |
| `/v1/conversation/threads` | GET | 501 | 200 when `ACP_CONVERSATION_DB_PATH` set (P1.3) |
| `/v1/gateway/deliveries?status=failed` | GET | 200 | 200 (P1.4) |
| `/v1/coordination/messages` | POST | 400 on empty body | 201 on valid (P1.5) |
| `/v1/messages` | POST | 410 `route_moved` | 410 (P1.8 sentinel) |
| `/v1/sessions` | GET | 200 | 200 (P0.4) |

Anomalies to investigate:
1. **P1.1a GET memberships / interface-identities not wired** (only POST registered). Gap doc lists these as admin surfaces. Check source for missing GET handler.
2. **P1.1c heartbeat CLI is stubbed** despite gap doc claim P1.1c delivered. HTTP routes exist but CLI help literally says "Stub: prints a not-implemented response".
3. **P1.2 `/v1/admin/jobs` GET returns 500** with no jobs — indicates store init failure or empty-list bug.
4. **P1.3 conversation returns 501** — probably missing `ACP_CONVERSATION_DB_PATH`, not a bug but operational gap per "Deferred follow-ups" note in source gap doc.

---

## Common setup

```bash
export ACP_SERVER_URL=http://127.0.0.1:18470
export ACP_ACTOR_AGENT_ID=clod
# Ensure env vars from .env.local are loaded; otherwise stores will be missing.
```

All CLI calls use `--json` where supported and pipe through `jq` for inspection.

---

## P1.1a — Admin governance APIs

### Objectives
- Create/list/show agents, projects, memberships, interface identities.
- Append and list system events.
- Verify rows land in `acp-admin.db`.

### Commands
```bash
# Agents
acp agent create --id validator-alpha --display-name "Validator Alpha" --status active --json
acp agent list --json
acp agent show --agent validator-alpha --json
acp agent patch --agent validator-alpha --display-name "Validator A" --json

# Projects
acp project create --id p1-smoke --display-name "P1 Smoke" --json
acp project list --json
acp project show --project p1-smoke --json
acp project default-agent --project p1-smoke --agent validator-alpha --json

# Memberships
acp membership add --project p1-smoke --agent validator-alpha --role operator --json
acp membership list --project p1-smoke --json

# Interface identities
acp interface identity register --gateway discord-test --external-id user:validator --json

# System events
acp system-event push --project p1-smoke --kind validation.tick \
  --payload '{"note":"p1 smoke"}' --occurred-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --json
acp system-event list --project p1-smoke --json
```

### Success criteria
- Each `create`/`add`/`register`/`push` returns 201 (or 200) with the persisted row.
- `list` includes the created row.
- `show` returns full fields.
- No 500s; payloads match created input.

### DB verification
```bash
sqlite3 "$ACP_ADMIN_DB_PATH" "select id, display_name, status from agents order by id limit 20;"
sqlite3 "$ACP_ADMIN_DB_PATH" "select project_id, agent_id, role from memberships order by 1, 2;"
```

### Fix dispatch if red
Wrkq task: `acp-p1a-missing-get`. Dispatch target: `cody@agent-spaces:T-XXXXX`. Scope: wire missing GET handlers for `/v1/admin/memberships` and `/v1/admin/interface-identities`, plus investigate any 500s on `/v1/admin/jobs`.

---

## P1.1c — Heartbeat

### Objectives
- `PUT /v1/admin/agents/:id/heartbeat` records a heartbeat.
- `POST /v1/agents/:id/heartbeat/wake` emits wake request.
- Stale-heartbeat system event fires at 10min threshold (verify from CLI log, not necessarily wall-clock).
- `acp heartbeat set|wake` CLI is functional (not a stub).

### Commands
```bash
# CLI (expected: functional per gap doc; observed: stub message)
acp heartbeat set --agent validator-alpha --json
acp heartbeat wake --agent validator-alpha --reason operator_wake --json

# Raw HTTP fallback if CLI is stub
curl -s -X PUT "$ACP_SERVER_URL/v1/admin/agents/validator-alpha/heartbeat" \
  -H "Content-Type: application/json" \
  -d '{"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'

curl -s -X POST "$ACP_SERVER_URL/v1/agents/validator-alpha/heartbeat/wake" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator_wake"}'

# Verify stale-event emission path
acp system-event list --kind agent.heartbeat.stale --json
```

### Success criteria
- CLI calls succeed with non-stub output.
- HTTP returns 200 with heartbeat payload / wake receipt.
- System event `agent.heartbeat.stale` emitted after configured threshold (synthetic test: manually pre-date last heartbeat to force stale).

### Fix dispatch if red
Wrkq task: `acp-p1c-heartbeat-cli-stub`. Dispatch cody. Scope: replace `acp heartbeat set|wake` stub with a thin wrapper over `PUT /v1/admin/agents/:id/heartbeat` and `POST /v1/agents/:id/heartbeat/wake`. Keep policy server-side.

---

## P1.2 — Jobs and scheduler

### Objectives
- Create/list/show jobs.
- Trigger manual run; verify job-run produced.
- `acp job list`, `acp job show`, `acp job-run list` return expected rows.
- Scheduler tick gated on `ACP_SCHEDULER_ENABLED=true` (verify via cron expression with a 1-minute interval).

### Commands
```bash
# Create a job
acp job create --id job-validator-tick \
  --project p1-smoke \
  --kind coordination.tick \
  --schedule "*/5 * * * *" \
  --payload '{"targetAgent":"validator-alpha"}' --json

acp job list --json
acp job show --job job-validator-tick --json
acp job run --job job-validator-tick --json              # manual trigger
acp job-run list --job job-validator-tick --json
acp job-run show --job-run <jobRunId> --json

# Verify 500 anomaly on GET /v1/admin/jobs
curl -s -o /tmp/jobs.json -w "%{http_code}\n" "$ACP_SERVER_URL/v1/admin/jobs"
cat /tmp/jobs.json
```

### Success criteria
- Job created, persisted, listable.
- Manual `run` yields a job-run row in lifecycle `pending → running → completed` or `failed`.
- Scheduler tick (if enabled) produces runs at interval (observed via `acp job-run list --json`).
- Catch-up policy: stop server during a scheduled fire, restart, verify a single catch-up run; subsequent schedule skips to next fire.

### Fix dispatch if red
Wrkq task: `acp-p1-2-jobs-list-500`. Dispatch cody. Scope: fix server-side 500 on GET `/v1/admin/jobs`; confirm `ACP_JOBS_DB_PATH` wired and default applied.

---

## P1.3 — Conversation surface

### Objectives
- Thread created on inbound interface message.
- Human turn created from interface ingress.
- Assistant turn created on run completion.
- Render state advances on delivery ack.
- Failed delivery moves render state to `failed`, not `delivered`.

### Setup
```bash
# Must restart server with ACP_CONVERSATION_DB_PATH set if currently missing.
export ACP_CONVERSATION_DB_PATH=~/praesidium/var/db/acp-conversation.db
```

### Commands
```bash
# 1. Inject an inbound interface message (through existing /v1/interface/messages)
curl -s -X POST "$ACP_SERVER_URL/v1/interface/messages" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "gateway": "discord-test",
  "conversationKey": "#p1-validation",
  "externalMessageId": "mid-001",
  "authorExternalId": "user:validator",
  "body": "hello validator",
  "replyToExternalId": null
}
JSON

# 2. List threads
acp thread list --project p1-smoke --json

# 3. Show a thread and its turns
acp thread show --thread <threadId> --json
acp thread turns --thread <threadId> --json
```

### Success criteria
- Exactly one thread per `conversationKey`.
- Human turn `status: delivered` for interface message.
- After agent run completes, assistant turn appears with `pending` → `streaming` → `delivered` sequence.
- On simulated fail (mark delivery failed), assistant turn render state transitions to `failed`.

### Fix dispatch if red
Wrkq task: `acp-p1-3-conversation-default-path`. Dispatch cody. Scope: consider auto-defaulting `ACP_CONVERSATION_DB_PATH` in the prod bin; fix 501 when env missing to return a clearer code.

---

## P1.4 — Delivery target + last-delivery context

### Objectives
- Resolve `DeliveryTarget { kind: "last" }` to a concrete channel from `last_delivery_context`.
- `last_delivery_context` ONLY advances on ack.
- Failed delivery keeps previous `last_delivery_context` intact.
- `acp delivery retry` creates a new attempt with `linked_failure_id`.

### Commands
```bash
# List failed deliveries (expected 200 even if empty)
acp delivery list-failed --json

# Retry a specific failed delivery
acp delivery retry --delivery <deliveryRequestId> --json

# Invariant check: simulate a failed delivery against a SessionRef that
# already has a last_delivery_context row; verify the row DOES NOT change.
sqlite3 "$ACP_INTERFACE_DB_PATH" \
  "select session_ref, gateway, conversation_key, updated_at from last_delivery_context;"
# Trigger fail via test harness or by pointing a delivery at a dead conversation.
# Re-read:
sqlite3 "$ACP_INTERFACE_DB_PATH" \
  "select session_ref, gateway, conversation_key, updated_at from last_delivery_context;"
# updated_at must be unchanged.
```

### Success criteria
- `list-failed` returns 200 and the expected shape.
- `retry` returns 201 with `newDeliveryRequestId` and `linkedFailureId == <original>`.
- Failed delivery probe shows no mutation of `last_delivery_context`.

### Fix dispatch if red
Wrkq task: `acp-p1-4-last-context-invariant`. Dispatch cody. Scope: confirm invariant test in `packages/acp-interface-store/test/` (should exist per gap doc). If missing or broken, re-land.

---

## P1.5 + P1.8 — Coordination messages

### Objectives
- `POST /v1/coordination/messages` with `options.coordinationOnly=true` creates only a coordination-event row.
- With `options.wake=true` creates a WakeRequest.
- With `options.dispatch=true` routes through `/inputs` (P0.5 shared path).
- `POST /v1/messages` returns `410 Gone` with `code: route_moved`.

### Commands
```bash
# coordinationOnly
curl -s -X POST "$ACP_SERVER_URL/v1/coordination/messages" \
  -H "Content-Type: application/json" -H "X-ACP-Actor: clod" \
  -d '{
    "projectId":"agent-spaces",
    "from":{"agentId":"clod"},
    "to":{"agentId":"cody"},
    "body":"P1 validation — coordinationOnly",
    "options":{"coordinationOnly":true}
  }' | jq .

# wake
curl -s -X POST "$ACP_SERVER_URL/v1/coordination/messages" \
  -H "Content-Type: application/json" -H "X-ACP-Actor: clod" \
  -d '{
    "projectId":"agent-spaces",
    "from":{"agentId":"clod"},
    "to":{"agentId":"cody"},
    "body":"P1 validation — wake",
    "options":{"wake":true}
  }' | jq .

# dispatch
curl -s -X POST "$ACP_SERVER_URL/v1/coordination/messages" \
  -H "Content-Type: application/json" -H "X-ACP-Actor: clod" \
  -d '{
    "projectId":"agent-spaces",
    "from":{"agentId":"clod"},
    "to":{"agentId":"cody"},
    "body":"P1 validation — dispatch",
    "options":{"dispatch":true}
  }' | jq .

# 410 sentinel
curl -s -X POST "$ACP_SERVER_URL/v1/messages" \
  -H "Content-Type: application/json" -H "X-ACP-Actor: clod" \
  -d '{"projectId":"agent-spaces"}' -w "\nHTTP: %{http_code}\n"

# CLI
acp message send --project agent-spaces --from-agent clod --to-agent cody \
  --text "P1 validation via CLI" --coordination-only --json
```

### Success criteria
- `coordinationOnly`: 201 with `{coordinationEventId, messageId}`; no wake, no run.
- `wake`: 201 with a `wakeRequestId` persisted; row visible via coordination substrate inspection.
- `dispatch`: 201 with `{inputAttemptId, runId}` referencing a P0 run.
- `/v1/messages`: `410` with body `{"error":{"code":"route_moved","message":"..."}}`.

### Fix dispatch if red
Wrkq task: `acp-p1-5-coordination-missing-option`. Dispatch cody.

---

## P1.6 — CLI surfaces

### Objectives
Each of the 12 landed command families accepts arguments per help and prints either a JSON or table result without error:
`agent`, `project`, `membership`, `runtime`, `session`, `run`, `send`, `tail`, `render`, `message`, `job`, `job-run`, `heartbeat`, `system-event`, `delivery`, `thread`.

### Smoke matrix
```bash
acp runtime resolve --scope-ref agent:clod:project:agent-spaces --json
acp session resolve --scope-ref agent:clod:project:agent-spaces --json
acp session list --json
acp session show --session <hsid> --json
acp session runs --session <hsid> --json
acp session capture --session <hsid> --lines 50
acp session attach-command --session <hsid>
acp run show --run <runId> --json
acp send --scope-ref agent:clod:project:agent-spaces --text "p1 smoke" --no-dispatch --json
acp tail --scope-ref agent:clod:project:agent-spaces --from-seq 0 | head -20
acp render --scope-ref agent:clod:project:agent-spaces --table
```

### Success criteria
- Each command exits 0 (or prints a meaningful error for missing resource, not a crash).
- `--json` output parses; `--table` output aligns.
- Any "stub" banner text is a bug to fix (observed: `acp heartbeat`).

---

## P1.7 — Actor stamping + authorize hook

### Objectives
- Mutating routes stamp `actor_kind`, `actor_id`, `actor_display_name` on durable rows (9 tables).
- Precedence: `X-ACP-Actor` header wins over body `actor` over env `ACP_ACTOR_AGENT_ID`.
- Default `authorize()` hook returns `allow`; verify 403 `authz_deny` is returnable (fault injection).

### Commands
```bash
# Header wins
curl -s -X POST "$ACP_SERVER_URL/v1/admin/system-events" \
  -H "Content-Type: application/json" \
  -H "X-ACP-Actor: actor-from-header" \
  -d '{"projectId":"agent-spaces","kind":"p1.probe","payload":{},"actor":{"agentId":"actor-from-body"}}' \
  | jq .
# Inspect persisted row
sqlite3 "$ACP_ADMIN_DB_PATH" \
  "select actor_kind, actor_id, actor_display_name from system_events order by rowid desc limit 1;"

# Body wins when header absent
ACP_ACTOR_AGENT_ID=env-actor curl -s -X POST "$ACP_SERVER_URL/v1/admin/system-events" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"agent-spaces","kind":"p1.probe","payload":{},"actor":{"agentId":"body-actor"}}' \
  | jq .

# Env default
ACP_ACTOR_AGENT_ID=env-actor curl -s -X POST "$ACP_SERVER_URL/v1/admin/system-events" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"agent-spaces","kind":"p1.probe","payload":{}}' | jq .
```

### Success criteria
- Row 1 → `actor_id=actor-from-header`.
- Row 2 → `actor_id=body-actor`.
- Row 3 → `actor_id=env-actor`.
- No row shows `unknown` or `null` actor after actor-stamping middleware.

---

## Execution order

1. Drive P1.5+P1.8 first (smallest, quickest signal).
2. Drive P1.1a admin next — creates the `validator-alpha` agent / `p1-smoke` project used by later phases.
3. P1.7 actor stamping (leverages P1.1a rows).
4. P1.1c heartbeat (depends on `validator-alpha` from P1.1a).
5. P1.2 jobs (depends on `p1-smoke`).
6. P1.4 delivery target.
7. P1.3 conversation (requires env reload + server restart).
8. P1.6 CLI surface smoke.

## Bug-fix orchestration

For each bug found:
1. `wrkq touch` a task with slug `acp-p1-<area>-<slug>` and structured repro.
2. `hrcchat dm cody@agent-spaces:T-XXXXX --wait --timeout 30m -` with short pointer + the constraint that `ASP_PROJECT=agent-spaces` runs the same ACP server this validation is hitting — cody should restart after fix (`stackctl restart dev` or targeted).
3. After fix lands, re-run the failing phase section; attach pass/fail to the wrkq task.

## Report template

At the end, emit a table:

| Phase | Expected | Observed | Status | Bug ticket |
|---|---|---|---|---|
| P1.1a agents | 200 create/list/show | … | green/red | T-… |
| P1.1a memberships GET | 200 list | 404 | red | T-… |
| … | … | … | … | … |
