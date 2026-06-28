#!/usr/bin/env bash
# Real-binary e2e for ACP/PBC semantic capabilities:
# installed `cap` -> catalogd -> http-json -> live acp-server.
#
# This is intentionally an executable smoke harness, not a unit test. It registers
# the provider manifests into a real catalogd process, invokes every cataloged
# ACP/PBC alias through the public cap CLI, and records whether each capability
# passed, hit a known adapter limitation, hit an explicit precondition block, or
# exposed an unexplained/manifest failure.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cap-acp-smoke-XXXXXX")"
SOCK="$WORKDIR/catalogd.sock"
CATLOG="$WORKDIR/catalogd.log"
CATPID=""

PASS=0
FAIL=0
BLOCK=0
DETAILS=()
MANIFEST_DEFECTS=()

SMOKE_ID="${SMOKE_ID:-cap-acp-$(date +%s)}"
ACP_BASE_URL="${ACP_BASE_URL:-http://127.0.0.1:18470}"
ACTOR="${ACTOR:-agent:smokey}"
HUMAN_ACTOR="${HUMAN_ACTOR:-human:smokey-e2e}"
SCOPE="${SCOPE:-agent:smokey:project:agent-control-plane:task:T-05186}"

AGENT_ID="${SMOKE_ID}-agent"
PROJECT_ID="${SMOKE_ID}-project"
SESSION_SCOPE="${SESSION_SCOPE:-agent:smokey:project:agent-control-plane:task:T-05186}"
LANE_REF="main"
GATEWAY_ID="cap-acp-smoke"
CONVERSATION_REF="channel:${SMOKE_ID}"
PBC_TASK_ID=""
WRKF_TASK_ID=""
SESSION_ID=""
RUN_ID=""
ATTACHMENT_RUN_ID=""
OUTBOUND_RUN_ID=""
CANCEL_RUN_ID=""
JOB_ID=""
JOB_RUN_ID=""
DELIVERY_ACK_ID=""
DELIVERY_FAIL_ID=""
DELIVERY_RETRY_ID=""
PBC_JOB_ID=""
INTERFACE_BINDING_ID=""

cleanup() {
  [ -n "$CATPID" ] && kill "$CATPID" 2>/dev/null
  close_seeded_wrkq_tasks
  if [ "${CAP_ACP_KEEP_WORKDIR:-0}" = "1" ]; then
    echo "keeping workdir: $WORKDIR"
    return
  fi
  rm -rf "$WORKDIR"
  return 0
}
trap cleanup EXIT

need() {
  command -v "$1" >/dev/null || {
    echo "missing required command: $1"
    exit 2
  }
}

run_cmd_timeout() {
  local timeout_sec="$1"
  local out="$2"
  local err="$3"
  shift 3
  rm -f "$out" "$err"
  "$@" >"$out" 2>"$err" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_sec" ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
}

register_provider_manifest() {
  local provider="$1"
  local manifest="$ROOT/capabilities/provider.${provider}.yaml"
  local out="$WORKDIR/register-${provider}.json"
  local err="$WORKDIR/register-${provider}.err"

  run_cmd_timeout 30 "$out" "$err" cap --server "$SOCK" provider register "$manifest" --json
}

json_get() {
  local file="$1"
  local path="$2"
  python3 - "$file" "$path" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1]))
    for part in [p for p in sys.argv[2].split('.') if p]:
        if isinstance(value, list):
            value = value[int(part)]
        else:
            value = value[part]
    if value is None:
        print('')
    elif isinstance(value, (dict, list)):
        print(json.dumps(value, separators=(',', ':')))
    else:
        print(value)
except Exception:
    print('')
PY
}

json_find_key() {
  local file="$1"
  local key="$2"
  python3 - "$file" "$key" <<'PY'
import json, sys
needle = sys.argv[2]
try:
    root = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)

def walk(v):
    if isinstance(v, dict):
        if needle in v and v[needle] is not None:
            return v[needle]
        for child in v.values():
            found = walk(child)
            if found is not None:
                return found
    elif isinstance(v, list):
        for child in v:
            found = walk(child)
            if found is not None:
                return found
    return None

found = walk(root)
if found is None:
    print('')
elif isinstance(found, (dict, list)):
    print(json.dumps(found, separators=(',', ':')))
else:
    print(found)
PY
}

write_input() {
  local alias="$1"
  local file="$2"
  ALIAS="$alias" \
  SMOKE_ID="$SMOKE_ID" \
  AGENT_ID="$AGENT_ID" \
  PROJECT_ID="$PROJECT_ID" \
  SESSION_SCOPE="$SESSION_SCOPE" \
  LANE_REF="$LANE_REF" \
  GATEWAY_ID="$GATEWAY_ID" \
  CONVERSATION_REF="$CONVERSATION_REF" \
  PBC_TASK_ID="$PBC_TASK_ID" \
  WRKF_TASK_ID="$WRKF_TASK_ID" \
  SESSION_ID="$SESSION_ID" \
  RUN_ID="$RUN_ID" \
  ATTACHMENT_RUN_ID="$ATTACHMENT_RUN_ID" \
  OUTBOUND_RUN_ID="$OUTBOUND_RUN_ID" \
  CANCEL_RUN_ID="$CANCEL_RUN_ID" \
  JOB_ID="$JOB_ID" \
  JOB_RUN_ID="$JOB_RUN_ID" \
  DELIVERY_ACK_ID="$DELIVERY_ACK_ID" \
  DELIVERY_FAIL_ID="$DELIVERY_FAIL_ID" \
  DELIVERY_RETRY_ID="$DELIVERY_RETRY_ID" \
  PBC_JOB_ID="$PBC_JOB_ID" \
  INTERFACE_BINDING_ID="$INTERFACE_BINDING_ID" \
  python3 - "$file" <<'PY'
import json, os, sys

a = os.environ['ALIAS']
smoke = os.environ['SMOKE_ID']
agent = os.environ['AGENT_ID']
project = os.environ['PROJECT_ID']
scope = os.environ['SESSION_SCOPE']
lane = os.environ['LANE_REF']
gateway = os.environ['GATEWAY_ID']
conversation = os.environ['CONVERSATION_REF']
pbc_task = os.environ.get('PBC_TASK_ID') or f'{smoke}-missing-pbc-task'
wrkf_task = os.environ.get('WRKF_TASK_ID') or f'{smoke}-missing-wrkf-task'
session_id = os.environ.get('SESSION_ID') or f'{smoke}-missing-session'
run_id = os.environ.get('RUN_ID') or f'{smoke}-missing-run'
attachment_run_id = os.environ.get('ATTACHMENT_RUN_ID') or run_id
outbound_run_id = os.environ.get('OUTBOUND_RUN_ID') or run_id
cancel_run_id = os.environ.get('CANCEL_RUN_ID') or run_id
job_id = os.environ.get('JOB_ID') or f'{smoke}-missing-job'
job_run_id = os.environ.get('JOB_RUN_ID') or f'{smoke}-missing-job-run'
delivery_ack = os.environ.get('DELIVERY_ACK_ID') or f'{smoke}-missing-delivery-ack'
delivery_fail = os.environ.get('DELIVERY_FAIL_ID') or f'{smoke}-missing-delivery-fail'
delivery_retry = os.environ.get('DELIVERY_RETRY_ID') or f'{smoke}-missing-delivery-retry'
pbc_job = os.environ.get('PBC_JOB_ID') or f'{smoke}-missing-pbc-job'
binding_id = os.environ.get('INTERFACE_BINDING_ID') or ''
session_ref = {'scopeRef': scope, 'laneRef': lane}

payloads = {
    'acp.agent.create': {
        'agentId': agent, 'displayName': f'Capability Smoke {smoke}',
        'status': 'active', 'homeDir': f'/Users/lherron/praesidium/var/agents/{agent}',
    },
    'acp.agent.patch': {'agentId': agent, 'displayName': f'Capability Smoke Patched {smoke}', 'status': 'active'},
    'acp.agent.patch.profile': {
        'agentId': agent, 'displayColor': '#2563EB', 'monogram': 'CS',
        'role': 'e2e validator', 'specialties': ['ACP', 'semantic-capabilities'],
    },
    'acp.agent.record_heartbeat': {
        'agentId': agent, 'source': 'cap-acp-e2e', 'note': smoke,
        'scopeRef': scope, 'laneRef': lane,
    },
    'acp.scope.create.project': {
        'projectId': project, 'displayName': f'Capability Smoke {smoke}',
        'rootDir': '/Users/lherron/praesidium/agent-control-plane',
    },
    'acp.scope.set_default_agent.project': {'projectId': project, 'agentId': agent},
    'acp.relation.create.project_membership': {'projectId': project, 'agentId': agent, 'role': 'tester'},
    'acp.session.resolve': {'sessionRef': session_ref},
    'acp.session.resolve_runtime': {'sessionRef': session_ref},
    'acp.session.submit_input': {
        'sessionRef': session_ref, 'content': f'cap-acp smoke input {smoke}',
        'dispatch': True, 'intent': {'kind': 'new_work'},
    },
    'acp.session.watch_events': {'sessionId': session_id, 'follow': False, 'fromSeq': 1},
    'acp.session.interrupt': {'sessionId': session_id},
    'acp.execution.get.run': {'runId': run_id},
    'acp.execution.cancel.run': {'runId': cancel_run_id},
    'acp.execution.start.workflow_participant_run': {
        'taskId': wrkf_task, 'role': 'tester', 'idempotencyKey': f'{smoke}:participant',
        'sessionRef': session_ref, 'initialPrompt': f'cap-acp participant smoke {smoke}',
    },
    'acp.execution.start.wrkf_action': {
        'taskId': wrkf_task, 'action': 'implement', 'role': 'tester',
        'idempotencyKey': f'{smoke}:wrkf-action', 'sessionRef': session_ref,
        'initialPrompt': f'cap-acp wrkf action smoke {smoke}',
    },
    'acp.surface.bind.interface': {
        'sessionRef': session_ref, 'gatewayId': gateway, 'gatewayType': 'discord',
        'conversationRef': conversation, 'status': 'active',
    },
    'acp.session.ingest_interface_message': {
        'source': {
            'gatewayId': gateway, 'conversationRef': conversation,
            'messageRef': f'{smoke}-message-1', 'authorRef': 'discord:user:cap-acp-smoke',
        },
        'content': f'cap-acp interface smoke {smoke}', 'intent': {'kind': 'new_work'},
    },
    'acp.publication.create.gateway_message': {
        'idempotencyKey': f'{smoke}:gateway-message:{delivery_ack or "seed"}',
        'text': f'cap-acp gateway message {smoke}', 'gatewayType': 'discord',
        'agentId': 'smokey', 'projectId': 'agent-control-plane', 'laneRef': lane,
        **({'bindingId': binding_id} if binding_id else {}),
    },
    'acp.publication.create.run_outbound_message': {'runId': outbound_run_id, 'text': f'cap-acp run outbound {smoke}'},
    'acp.artifact.create.run_outbound_attachment': {
        'runId': attachment_run_id, 'file': 'Y2FwLWFjcCBhdHRhY2htZW50IHNtb2tlCg==',
        'filename': 'cap-acp-example.txt', 'contentType': 'text/plain', 'alt': 'cap-acp smoke attachment',
    },
    'acp.effect.watch.gateway_deliveries': {'status': 'failed', 'gatewayId': gateway, 'limit': 50},
    'acp.effect.ack.gateway_delivery': {'deliveryRequestId': delivery_ack},
    'acp.effect.fail.gateway_delivery': {'deliveryRequestId': delivery_fail, 'code': 'cap_acp_smoke', 'message': smoke},
    'acp.effect.retry.gateway_delivery': {'deliveryRequestId': delivery_retry, 'requeuedBy': 'smokey'},
    'acp.workflow_definition.validate.automation_job': {'schedule': {'cron': '0 9 * * *'}, 'flow': {'version': 1, 'steps': []}},
    'acp.workflow_definition.create.automation_job': {
        'agentId': agent, 'projectId': project, 'scopeRef': scope, 'laneRef': lane,
        'schedule': {'cron': '0 9 * * *'}, 'input': {'content': f'cap-acp automation {smoke}'},
        'slug': f'{smoke}-daily',
    },
    'acp.workflow_definition.patch.automation_job': {'jobId': job_id, 'disabled': True, 'description': f'patched by {smoke}'},
    'acp.execution.start.automation_job': {'jobId': job_id},
    'acp.execution.get.automation_job_run': {'jobRunId': job_run_id},
    'acp.event.ingest.normalized': {
        'schema_version': 1, 'source': 'cap-acp-smoke',
        'event_id': f'{smoke}-event', 'event_seq': 1,
        'event': 'cap-acp.smoke.completed',
        'occurred_at': '2026-06-28T04:00:00.000Z',
        'origin': {'kind': 'system', 'actor': 'system:cap-acp-smoke'},
        'subject': {'type': 'capability-smoke', 'id': smoke},
        'payload': {'smokeId': smoke},
    },
    'pbc.workflow_instance.start.progressive_refinement': {
        'taskId': pbc_task, 'idempotencyKey': f'{smoke}:pbc-start',
        'intake': {'title': f'PBC smoke {smoke}', 'summary': 'Exercise PBC semantic capability route.'},
    },
    'pbc.workflow_instance.get.progressive_refinement': {'taskId': pbc_task},
    'pbc.workflow_instance.submit_input.progressive_refinement': {
        'taskId': pbc_task, 'kind': 'clarification_response',
        'idempotencyKey': f'{smoke}:pbc-input',
        'data': {'answer': 'Use the e2e harness result as the acceptance signal.'},
    },
    'pbc.workflow_instance.continue.progressive_refinement': {'taskId': pbc_task, 'idempotencyKey': f'{smoke}:pbc-continue'},
    'pbc.workflow_instance.dispose.progressive_refinement': {'taskId': pbc_task, 'resolution': 'wont_fix', 'reason': f'cap-acp smoke cleanup {smoke}'},
    'pbc.effect.reconcile.progressive_refinement': {'taskId': pbc_task},
    'pbc.execution.get.continuation_job': {'jobId': pbc_job},
}

if a not in payloads:
    raise SystemExit(f'no payload for {a}')
json.dump(payloads[a], open(sys.argv[1], 'w'), separators=(',', ':'))
PY
}

record_pass() {
  local alias="$1"
  local reason="$2"
  PASS=$((PASS + 1))
  DETAILS+=("PASS  ${alias} - ${reason}")
  echo "PASS  ${alias} - ${reason}"
}

record_fail() {
  local alias="$1"
  local reason="$2"
  FAIL=$((FAIL + 1))
  DETAILS+=("FAIL  ${alias} - ${reason}")
  MANIFEST_DEFECTS+=("${alias}: ${reason}")
  echo "FAIL  ${alias} - ${reason}"
}

record_block() {
  local alias="$1"
  local kind="$2"
  local reason="$3"
  BLOCK=$((BLOCK + 1))
  DETAILS+=("${kind}  ${alias} - ${reason}")
  echo "${kind}  ${alias} - ${reason}"
}

invoke_raw() {
  local alias="$1"
  local input="$2"
  local key="$3"
  local out="$4"
  local err="$5"
  local timeout_sec="${6:-45}"
  local actor="${7-$ACTOR}"

  rm -f "$out" "$err" "$out.status"
  (
    local args=(cap --server "$SOCK" invoke "$alias" --input "$input" --scope "$SCOPE")
    if [ -n "$actor" ]; then
      args+=(--actor "$actor")
    fi
    if [ -n "$key" ]; then
      args+=(--idempotency-key "$key")
    fi
    args+=(--json)
    env -u HRC_RUN_ID -u HRC_HOST_SESSION_ID -u HRC_GENERATION \
      "${args[@]}" >"$out" 2>"$err"
  ) &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$timeout_sec" ]; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      echo 124 >"$out.status"
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  local status=$?
  echo "$status" >"$out.status"
  return "$status"
}

assert_operation_succeeded() {
  local alias="$1"
  local opid="$2"
  [ -n "$opid" ] || {
    record_fail "$alias" "invoke succeeded without operationId"
    return 1
  }
  local opout="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.op.json"
  local operr="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.op.err"
  cap --server "$SOCK" operation status "$opid" --json >"$opout" 2>"$operr"
  local opstatus
  opstatus="$(json_get "$opout" status)"
  if [ "$opstatus" = "succeeded" ]; then
    return 0
  fi
  record_fail "$alias" "operation status for ${opid} was '${opstatus:-missing}' ($(tr '\n' ' ' <"$operr"))"
  return 1
}

run_cap() {
  local alias="$1"
  local persistence="$2"
  local key="${3:-}"
  local timeout_sec="${4:-45}"
  local actor="${5-$ACTOR}"
  local input="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.input.json"
  local out="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.json"
  local err="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.err"

  write_input "$alias" "$input"
  invoke_raw "$alias" "$input" "$key" "$out" "$err" "$timeout_sec" "$actor"
  local rc=$?
  if [ "$rc" -eq 124 ]; then
    record_fail "$alias" "cap invoke timed out after ${timeout_sec}s"
    return 1
  fi

  local status
  status="$(json_get "$out" status)"
  if [ "$status" != "succeeded" ]; then
    local eclass ecode emsg stderr
    eclass="$(json_get "$out" error.class)"
    ecode="$(json_get "$out" error.code)"
    emsg="$(json_get "$out" error.message)"
    stderr="$(tr '\n' ' ' <"$err")"
    record_fail "$alias" "status=${status:-missing} class=${eclass:-missing} code=${ecode:-missing} message=${emsg:-$stderr}"
    return 1
  fi

  local opid
  opid="$(json_get "$out" operationId)"
  if [ "$persistence" = "operation_and_execution" ]; then
    assert_operation_succeeded "$alias" "$opid" || return 1
    if [ -n "$key" ]; then
      local replay="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.replay.json"
      local replay_err="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.replay.err"
      invoke_raw "$alias" "$input" "$key" "$replay" "$replay_err" "$timeout_sec" "$actor"
      local replay_status replay_opid
      replay_status="$(json_get "$replay" status)"
      replay_opid="$(json_get "$replay" operationId)"
      if [ "$replay_status" != "succeeded" ] || [ "$replay_opid" != "$opid" ]; then
        record_fail "$alias" "idempotency replay did not dedupe (first=${opid}, replay=${replay_opid:-missing}, status=${replay_status:-missing})"
        return 1
      fi
    fi
  fi

  record_pass "$alias" "status=succeeded${opid:+ op=${opid}}"
  return 0
}

run_watch_events_live() {
  local alias="acp.session.watch_events"
  local input="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.input.json"
  local out="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.json"
  local err="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.err"
  write_input "$alias" "$input"
  invoke_raw "$alias" "$input" "" "$out" "$err" 45
  local rc=$?
  if [ "$rc" -eq 124 ]; then
    record_fail "$alias" "cap invoke timed out after 45s"
    return 1
  fi
  local status
  status="$(json_get "$out" status)"
  if [ "$status" != "succeeded" ]; then
    record_fail "$alias" "status=${status:-missing} message=$(json_get "$out" error.message) stderr=$(tr '\n' ' ' <"$err")"
    return 1
  fi
  local frames
  frames="$(python3 - "$out" <<'PY'
import json, sys
try:
    output = json.load(open(sys.argv[1])).get('output')
except Exception:
    raise SystemExit(2)
if not isinstance(output, list):
    raise SystemExit(1)
print(len(output))
PY
)"
  local shape_rc=$?
  if [ "$shape_rc" -ne 0 ]; then
    record_fail "$alias" "expected output to be an array of ndjson frames"
    return 1
  fi
  record_pass "$alias" "status=succeeded output=array frames=${frames}"
  return 0
}

run_outbound_attachment_live() {
  local alias="acp.artifact.create.run_outbound_attachment"
  local key="${SMOKE_ID}:attachment"
  local input="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.input.json"
  local out="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.json"
  local err="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.err"

  write_input "$alias" "$input"
  invoke_raw "$alias" "$input" "$key" "$out" "$err" 45
  local rc=$?
  if [ "$rc" -eq 124 ]; then
    record_fail "$alias" "cap invoke timed out after 45s"
    return 1
  fi
  local status
  status="$(json_get "$out" status)"
  if [ "$status" != "succeeded" ]; then
    record_fail "$alias" "status=${status:-missing} message=$(json_get "$out" error.message) stderr=$(tr '\n' ' ' <"$err")"
    return 1
  fi

  local opid attachment_id filename
  opid="$(json_get "$out" operationId)"
  assert_operation_succeeded "$alias" "$opid" || return 1
  attachment_id="$(json_find_key "$out" outboundAttachmentId)"
  filename="$(json_find_key "$out" filename)"
  if [ -z "$attachment_id" ] || [ "$filename" != "cap-acp-example.txt" ]; then
    record_fail "$alias" "invoke succeeded but attachment metadata was missing or wrong (attachment=${attachment_id:-missing}, filename=${filename:-missing})"
    return 1
  fi

  local replay="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.replay.json"
  local replay_err="$WORKDIR/${alias//[^A-Za-z0-9_]/_}.replay.err"
  invoke_raw "$alias" "$input" "$key" "$replay" "$replay_err" 45
  local replay_status replay_opid
  replay_status="$(json_get "$replay" status)"
  replay_opid="$(json_get "$replay" operationId)"
  if [ "$replay_status" != "succeeded" ] || [ "$replay_opid" != "$opid" ]; then
    record_fail "$alias" "idempotency replay did not dedupe (first=${opid}, replay=${replay_opid:-missing}, status=${replay_status:-missing})"
    return 1
  fi

  record_pass "$alias" "status=succeeded op=${opid} attachment=${attachment_id}"
  return 0
}

seed_delivery() {
  local suffix="$1"
  local old_ack="$DELIVERY_ACK_ID"
  DELIVERY_ACK_ID="$suffix"
  local alias="acp.publication.create.gateway_message"
  local input="$WORKDIR/delivery-${suffix}.json"
  local out="$WORKDIR/delivery-${suffix}.out.json"
  local err="$WORKDIR/delivery-${suffix}.err"
  write_input "$alias" "$input"
  invoke_raw "$alias" "$input" "${SMOKE_ID}:delivery:${suffix}" "$out" "$err" 45
  DELIVERY_ACK_ID="$old_ack"
  local status
  status="$(json_get "$out" status)"
  if [ "$status" != "succeeded" ]; then
    echo ""
    return 0
  fi
  json_find_key "$out" deliveryRequestId
}

seed_pbc_task() {
  local slug="$1"
  local title="$2"
  local out="$WORKDIR/wrkq-task.json"
  wrkq touch "inbox/${slug}" --state open --priority 4 -t "$title" -d - >"$out" <<EOF
Throwaway real wrkq task for scripts/e2e/cap-acp/smoke.sh.

SMOKE_ID: ${SMOKE_ID}
EOF
  local id
  id="$(json_get "$out" id)"
  [ -n "$id" ] || id="$(json_get "$out" 0.id)"
  echo "$id"
}

seed_wrkf_task() {
  local task_id="$1"
  [ -n "$task_id" ] || return 1
  wrkf --actor agent:smokey --role tester task attach "$task_id" --workflow wrkq-simple-task@1 --json >/dev/null
}

close_seeded_wrkq_task() {
  local task_id="$1"
  [ -n "$task_id" ] || return 0
  command -v wrkq >/dev/null 2>&1 || return 0

  wrkq comment add "$task_id" -m "cap-acp smoke cleanup: closing throwaway task ${SMOKE_ID}" >/dev/null 2>&1 || true
  wrkq set "$task_id" --state completed --resolution done >/dev/null 2>&1 || true
}

close_seeded_wrkq_tasks() {
  if [ -n "$PBC_TASK_ID" ]; then
    close_seeded_wrkq_task "$PBC_TASK_ID"
  fi
  if [ -n "$WRKF_TASK_ID" ] && [ "$WRKF_TASK_ID" != "$PBC_TASK_ID" ]; then
    close_seeded_wrkq_task "$WRKF_TASK_ID"
  fi
}

seed_session_run() {
  local suffix="$1"
  local old_run="$RUN_ID"
  local old_session_id="$SESSION_ID"
  local alias="acp.session.submit_input"
  local input="$WORKDIR/seed-run-${suffix}.input.json"
  local out="$WORKDIR/seed-run-${suffix}.out.json"
  local err="$WORKDIR/seed-run-${suffix}.err"
  RUN_ID=""
  write_input "$alias" "$input"
  python3 - "$input" "$suffix" <<'PY'
import json, sys
path, suffix = sys.argv[1], sys.argv[2]
data = json.load(open(path))
data['content'] = f"{data['content']} ({suffix})"
json.dump(data, open(path, 'w'), separators=(',', ':'))
PY
  invoke_raw "$alias" "$input" "${SMOKE_ID}:seed-run:${suffix}" "$out" "$err" 90
  RUN_ID="$old_run"
  SESSION_ID="$old_session_id"
  if [ "$(json_get "$out" status)" != "succeeded" ]; then
    echo ""
    return 0
  fi
  json_find_key "$out" runId
}

seed_pending_attachment_run() {
  local old_run="$RUN_ID"
  local old_session_id="$SESSION_ID"
  local alias="acp.session.submit_input"
  local input="$WORKDIR/seed-attachment-run.input.json"
  local out="$WORKDIR/seed-attachment-run.out.json"
  local err="$WORKDIR/seed-attachment-run.err"
  RUN_ID=""
  SESSION_ID=""
  write_input "$alias" "$input"
  python3 - "$input" <<'PY'
import json, os, sys
path = sys.argv[1]
data = json.load(open(path))
smoke = os.environ.get('SMOKE_ID', 'cap-acp-smoke')
data['sessionRef'] = {
    'scopeRef': f'agent:smokey:project:agent-control-plane:task:{smoke}-attachment',
    'laneRef': 'main',
}
data['content'] = f'cap-acp attachment seed {smoke}'
data['dispatch'] = False
json.dump(data, open(path, 'w'), separators=(',', ':'))
PY
  invoke_raw "$alias" "$input" "${SMOKE_ID}:attachment-seed-run" "$out" "$err" 45
  RUN_ID="$old_run"
  SESSION_ID="$old_session_id"
  if [ "$(json_get "$out" status)" != "succeeded" ]; then
    echo ""
    return 0
  fi
  json_find_key "$out" runId
}

get_run_status() {
  local run_id="$1"
  local out="$WORKDIR/run-status-${run_id//[^A-Za-z0-9_]/_}.json"
  curl -fsS "${ACP_BASE_URL}/v1/runs/${run_id}" >"$out" 2>/dev/null || {
    echo ""
    return 0
  }
  json_find_key "$out" status
}

run_outbound_message_if_active() {
  if [ -z "$OUTBOUND_RUN_ID" ]; then
    record_block "acp.publication.create.run_outbound_message" "PRECONDITION-BLOCKED" "no interface-originated runId was produced by acp.session.ingest_interface_message"
    return 0
  fi

  local status
  status="$(get_run_status "$OUTBOUND_RUN_ID")"
  case "$status" in
    pending|started|running)
      run_cap "acp.publication.create.run_outbound_message" "operation_and_execution" "${SMOKE_ID}:run-outbound"
      ;;
    *)
      record_block "acp.publication.create.run_outbound_message" "PRECONDITION-BLOCKED" "interface-originated run ${OUTBOUND_RUN_ID} has status '${status:-missing}', but /v1/runs/:runId/outbound-messages requires pending|started|running"
      ;;
  esac
}

echo "== ACP/PBC capability http-json e2e =="
echo "SMOKE_ID=$SMOKE_ID"
echo "ACP_BASE_URL=$ACP_BASE_URL"
echo "ACP target: running dev server with namespaced throwaway data"

need cap
need catalogd
need python3
need curl
need wrkq

if ! curl -fsS "$ACP_BASE_URL/v1/mobile/health" >/dev/null 2>&1; then
  echo "FAIL: acp-server is not reachable at $ACP_BASE_URL"
  exit 1
fi

echo "== start catalogd with ACP_BASE_URL in process env =="
ACP_BASE_URL="$ACP_BASE_URL" catalogd --listen "$SOCK" >"$CATLOG" 2>&1 &
CATPID=$!
for _ in $(seq 1 40); do
  [ -S "$SOCK" ] && break
  sleep 0.2
done
[ -S "$SOCK" ] || {
  echo "FAIL: catalogd did not bind"
  cat "$CATLOG"
  exit 1
}

echo "== provider registration mode =="
echo "Registering full provider manifests from capabilities/provider.{acp,pbc}.yaml."
if ! register_provider_manifest acp; then
  echo "FAIL: could not register full ACP provider manifest"
  cat "$WORKDIR/register-acp.err"
  exit 1
fi
if ! register_provider_manifest pbc; then
  echo "FAIL: could not register full PBC provider manifest"
  cat "$WORKDIR/register-pbc.err"
  exit 1
fi

echo "== seed real wrkq task for PBC route preconditions =="
PBC_TASK_ID="$(seed_pbc_task "${SMOKE_ID}-pbc" "Cap ACP PBC smoke ${SMOKE_ID}")"
if [ -z "$PBC_TASK_ID" ]; then
  echo "FAIL: could not create wrkq seed task"
  exit 1
fi
echo "PBC_TASK_ID=$PBC_TASK_ID"

echo "== seed real wrkf task for WRKF action/participant preconditions =="
WRKF_TASK_ID="$(seed_pbc_task "${SMOKE_ID}-wrkf" "Cap ACP WRKF smoke ${SMOKE_ID}")"
if [ -z "$WRKF_TASK_ID" ]; then
  echo "FAIL: could not create wrkf seed task"
  exit 1
fi
if ! seed_wrkf_task "$WRKF_TASK_ID"; then
  echo "FAIL: could not attach wrkq-simple-task workflow to $WRKF_TASK_ID"
  exit 1
fi
echo "WRKF_TASK_ID=$WRKF_TASK_ID"

echo "== invoke ACP capabilities =="
run_cap "acp.agent.create" "operation_and_execution" "${SMOKE_ID}:agent-create"
run_cap "acp.agent.patch" "operation_and_execution" "${SMOKE_ID}:agent-patch"
run_cap "acp.agent.patch.profile" "operation_and_execution" "${SMOKE_ID}:agent-profile"
run_cap "acp.agent.record_heartbeat" "operation_and_execution" "${SMOKE_ID}:agent-heartbeat"
run_cap "acp.scope.create.project" "operation_and_execution" "${SMOKE_ID}:project-create"
run_cap "acp.relation.create.project_membership" "operation_and_execution" "${SMOKE_ID}:membership"
run_cap "acp.scope.set_default_agent.project" "operation_and_execution" "${SMOKE_ID}:project-default"

if run_cap "acp.session.resolve" "operation_and_execution" "${SMOKE_ID}:session-resolve"; then
  SESSION_ID="$(json_find_key "$WORKDIR/acp_session_resolve.json" sessionId)"
  [ -n "$SESSION_ID" ] || SESSION_ID="$(json_find_key "$WORKDIR/acp_session_resolve.json" id)"
fi
run_cap "acp.session.resolve_runtime" "operation_and_execution" "${SMOKE_ID}:runtime-resolve"
if run_cap "acp.session.submit_input" "operation_and_execution" "${SMOKE_ID}:submit-input" 90; then
  RUN_ID="$(json_find_key "$WORKDIR/acp_session_submit_input.json" runId)"
fi

if [ -z "$RUN_ID" ]; then
  record_block "acp.execution.get.run" "PRECONDITION-BLOCKED" "no runId was produced by acp.session.submit_input"
else
  run_cap "acp.execution.get.run" "none"
fi

run_watch_events_live
if run_cap "acp.execution.start.workflow_participant_run" "operation_and_execution" "${SMOKE_ID}:participant-run" 90 ""; then
  ATTACHMENT_RUN_ID="$(seed_pending_attachment_run)"
fi
if [ -z "$ATTACHMENT_RUN_ID" ]; then
  record_block "acp.artifact.create.run_outbound_attachment" "PRECONDITION-BLOCKED" "could not seed a dispatch:false submit_input run for outbound attachment"
else
  run_outbound_attachment_live
fi
run_cap "acp.session.interrupt" "operation_and_execution" "${SMOKE_ID}:session-interrupt"
run_cap "acp.execution.start.wrkf_action" "operation_and_execution" "${SMOKE_ID}:wrkf-action" 90
if run_cap "acp.surface.bind.interface" "operation_and_execution" "${SMOKE_ID}:bind-interface"; then
  INTERFACE_BINDING_ID="$(json_find_key "$WORKDIR/acp_surface_bind_interface.json" bindingId)"
fi
if run_cap "acp.session.ingest_interface_message" "operation_and_execution" "${SMOKE_ID}:interface-message" 90; then
  OUTBOUND_RUN_ID="$(json_find_key "$WORKDIR/acp_session_ingest_interface_message.json" runId)"
  [ -z "$RUN_ID" ] && RUN_ID="$OUTBOUND_RUN_ID"
fi
run_outbound_message_if_active

if run_cap "acp.publication.create.gateway_message" "operation_and_execution" "${SMOKE_ID}:gateway-message"; then
  DELIVERY_ACK_ID="$(json_find_key "$WORKDIR/acp_publication_create_gateway_message.json" deliveryRequestId)"
fi

CANCEL_RUN_ID="$(seed_session_run "cancel")"
if [ -z "$CANCEL_RUN_ID" ]; then
  record_block "acp.execution.cancel.run" "PRECONDITION-BLOCKED" "could not seed a fresh run for cancel"
else
  run_cap "acp.execution.cancel.run" "operation_and_execution" "${SMOKE_ID}:cancel-run"
fi
run_cap "acp.effect.watch.gateway_deliveries" "none"

DELIVERY_FAIL_ID="$(seed_delivery "fail")"
DELIVERY_RETRY_ID="$(seed_delivery "retry")"
[ -z "$DELIVERY_ACK_ID" ] && DELIVERY_ACK_ID="$(seed_delivery "ack")"

if [ -z "$DELIVERY_ACK_ID" ]; then
  record_block "acp.effect.ack.gateway_delivery" "PRECONDITION-BLOCKED" "could not seed a gateway delivery request"
else
  run_cap "acp.effect.ack.gateway_delivery" "operation_and_execution" "${SMOKE_ID}:ack-delivery"
fi
if [ -z "$DELIVERY_FAIL_ID" ]; then
  record_block "acp.effect.fail.gateway_delivery" "PRECONDITION-BLOCKED" "could not seed a gateway delivery request"
else
  run_cap "acp.effect.fail.gateway_delivery" "operation_and_execution" "${SMOKE_ID}:fail-delivery"
fi
if [ -z "$DELIVERY_RETRY_ID" ]; then
  record_block "acp.effect.retry.gateway_delivery" "PRECONDITION-BLOCKED" "could not seed a gateway delivery request"
else
  RETRY_FAIL_INPUT="$WORKDIR/retry-fail.input.json"
  RETRY_FAIL_OUT="$WORKDIR/retry-fail.out.json"
  RETRY_FAIL_ERR="$WORKDIR/retry-fail.err"
  OLD_DELIVERY_FAIL_ID="$DELIVERY_FAIL_ID"
  DELIVERY_FAIL_ID="$DELIVERY_RETRY_ID"
  write_input "acp.effect.fail.gateway_delivery" "$RETRY_FAIL_INPUT"
  DELIVERY_FAIL_ID="$OLD_DELIVERY_FAIL_ID"
  invoke_raw "acp.effect.fail.gateway_delivery" "$RETRY_FAIL_INPUT" "${SMOKE_ID}:fail-before-retry" "$RETRY_FAIL_OUT" "$RETRY_FAIL_ERR" 45
  if [ "$(json_get "$RETRY_FAIL_OUT" status)" = "succeeded" ]; then
    run_cap "acp.effect.retry.gateway_delivery" "operation_and_execution" "${SMOKE_ID}:retry-delivery"
  else
    record_block "acp.effect.retry.gateway_delivery" "PRECONDITION-BLOCKED" "could not mark seeded delivery failed before retry ($(json_get "$RETRY_FAIL_OUT" error.message))"
  fi
fi

run_cap "acp.workflow_definition.validate.automation_job" "none"
if run_cap "acp.workflow_definition.create.automation_job" "operation_and_execution" "${SMOKE_ID}:job-create"; then
  JOB_ID="$(json_find_key "$WORKDIR/acp_workflow_definition_create_automation_job.json" jobId)"
  [ -n "$JOB_ID" ] || JOB_ID="$(json_find_key "$WORKDIR/acp_workflow_definition_create_automation_job.json" id)"
fi
if [ -z "$JOB_ID" ]; then
  record_block "acp.workflow_definition.patch.automation_job" "PRECONDITION-BLOCKED" "no jobId was produced by acp.workflow_definition.create.automation_job"
  record_block "acp.execution.start.automation_job" "PRECONDITION-BLOCKED" "no jobId was produced by acp.workflow_definition.create.automation_job"
else
  run_cap "acp.workflow_definition.patch.automation_job" "operation_and_execution" "${SMOKE_ID}:job-patch"
  if run_cap "acp.execution.start.automation_job" "operation_and_execution" "${SMOKE_ID}:job-run"; then
    JOB_RUN_ID="$(json_find_key "$WORKDIR/acp_execution_start_automation_job.json" jobRunId)"
    [ -n "$JOB_RUN_ID" ] || JOB_RUN_ID="$(json_find_key "$WORKDIR/acp_execution_start_automation_job.json" id)"
  fi
fi
if [ -z "$JOB_RUN_ID" ]; then
  record_block "acp.execution.get.automation_job_run" "PRECONDITION-BLOCKED" "no jobRunId was produced by acp.execution.start.automation_job"
else
  run_cap "acp.execution.get.automation_job_run" "none"
fi
run_cap "acp.event.ingest.normalized" "operation_and_execution" "${SMOKE_ID}:event-ingest"

echo "== invoke PBC capabilities =="
if run_cap "pbc.workflow_instance.start.progressive_refinement" "operation_and_execution" "${SMOKE_ID}:pbc-start" 90; then
  PBC_JOB_ID="$(json_get "$WORKDIR/pbc_workflow_instance_start_progressive_refinement.json" output.activeJob.id)"
  [ -n "$PBC_JOB_ID" ] || PBC_JOB_ID="$(json_find_key "$WORKDIR/pbc_workflow_instance_start_progressive_refinement.json" jobId)"
fi
run_cap "pbc.workflow_instance.get.progressive_refinement" "none"
PBC_SCREEN="$(json_get "$WORKDIR/pbc_workflow_instance_get_progressive_refinement.json" output.screen)"
case "$PBC_SCREEN" in
  clarification)
    run_cap "pbc.workflow_instance.submit_input.progressive_refinement" "operation_and_execution" "${SMOKE_ID}:pbc-input" 90 "$HUMAN_ACTOR"
    ;;
  patch_decision)
    record_block "pbc.workflow_instance.submit_input.progressive_refinement" "PRECONDITION-BLOCKED" "current screen is patch_decision; harness does not synthesize a patch_decision payload"
    ;;
  *)
    record_block "pbc.workflow_instance.submit_input.progressive_refinement" "PRECONDITION-BLOCKED" "current screen '${PBC_SCREEN:-missing}' does not accept clarification_response input"
    ;;
esac
if run_cap "pbc.workflow_instance.continue.progressive_refinement" "operation_and_execution" "${SMOKE_ID}:pbc-continue" 90; then
  [ -z "$PBC_JOB_ID" ] && PBC_JOB_ID="$(json_get "$WORKDIR/pbc_workflow_instance_continue_progressive_refinement.json" output.activeJob.id)"
  [ -z "$PBC_JOB_ID" ] && PBC_JOB_ID="$(json_find_key "$WORKDIR/pbc_workflow_instance_continue_progressive_refinement.json" jobId)"
fi
run_cap "pbc.workflow_instance.dispose.progressive_refinement" "operation_and_execution" "${SMOKE_ID}:pbc-dispose" 90 "$HUMAN_ACTOR"
run_cap "pbc.effect.reconcile.progressive_refinement" "operation_and_execution" "${SMOKE_ID}:pbc-reconcile" 90
if [ -z "$PBC_JOB_ID" ]; then
  record_block "pbc.execution.get.continuation_job" "PRECONDITION-BLOCKED" "no continuation jobId was produced by PBC start/continue"
else
  run_cap "pbc.execution.get.continuation_job" "none"
fi

echo "== negative error-class mapping =="
NEG_IN="$WORKDIR/negative-agent-profile.json"
python3 - "$NEG_IN" <<'PY'
import json, sys
json.dump({'agentId': 'cap-acp-missing-agent', 'role': 'missing'}, open(sys.argv[1], 'w'))
PY
NEG_OUT="$WORKDIR/negative-agent-profile.out.json"
NEG_ERR="$WORKDIR/negative-agent-profile.err"
invoke_raw "acp.agent.patch.profile" "$NEG_IN" "${SMOKE_ID}:negative-404" "$NEG_OUT" "$NEG_ERR" 30
NEG_CLASS="$(json_get "$NEG_OUT" error.class)"
if [ "$NEG_CLASS" = "resource_not_found" ]; then
  record_pass "negative.acp.agent.patch.profile.404" "404 mapped to resource_not_found"
else
  record_fail "negative.acp.agent.patch.profile.404" "expected resource_not_found, got class=${NEG_CLASS:-missing} body=$(tr '\n' ' ' <"$NEG_OUT" 2>/dev/null)"
fi

echo
echo "=== ACP/PBC CAP E2E: ${PASS} pass / ${FAIL} fail / ${BLOCK} blocked ==="
printf '%s\n' "${DETAILS[@]}"

if [ "${#MANIFEST_DEFECTS[@]}" -gt 0 ]; then
  echo
  echo "=== MANIFEST DEFECTS / UNEXPLAINED FAILURES ==="
  printf '%s\n' "${MANIFEST_DEFECTS[@]}"
fi

[ "$FAIL" -eq 0 ]
