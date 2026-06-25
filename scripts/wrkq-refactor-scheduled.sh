#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${WRKQ_REFACTOR_REPO_ROOT:-/Users/lherron/praesidium/agent-control-plane}"
LOG_DIR="${WRKQ_REFACTOR_LOG_DIR:-/Users/lherron/praesidium/var/logs}"
RUN_DIR="${WRKQ_REFACTOR_RUN_DIR:-/Users/lherron/praesidium/var/run}"
LOCK_DIR="${RUN_DIR}/acp-wrkq-refactor.lock"
LOG_PATH="${LOG_DIR}/acp-wrkq-refactor.log"
EMAIL_TO="${WRKQ_REFACTOR_EMAIL_TO:-lherron@gmail.com}"
EMAIL_ACCOUNT="${WRKQ_REFACTOR_EMAIL_ACCOUNT:-lherron@gmail.com}"
RUN_ID="${WRKQ_REFACTOR_RUN_ID:-$(date -u +"%Y%m%dT%H%M%SZ")-$$}"
TARGET_TASK="wrkq-refactor-${RUN_ID}"
TARGET="cody@agent-control-plane:${TARGET_TASK}"
TARGET_SCOPE_REF="agent:cody:project:agent-control-plane:task:${TARGET_TASK}"

mkdir -p "$LOG_DIR" "$RUN_DIR"
exec >>"$LOG_PATH" 2>&1

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

echo "[$(timestamp)] wrkq-refactor scheduled tick"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(timestamp)] another wrkq-refactor run is active; skipping"
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

cd "$REPO_ROOT"

export PATH="/Users/lherron/.local/bin:/Users/lherron/.bun/bin:/Users/lherron/.tooling/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${HOME:-/Users/lherron}"
export LANG="${LANG:-en_US.UTF-8}"
export ASP_PROJECT="${ASP_PROJECT:-agent-control-plane}"
export ASP_HOME="${ASP_HOME:-/Users/lherron/praesidium/var/spaces-repo}"
export ASP_AGENTS_ROOT="${ASP_AGENTS_ROOT:-/Users/lherron/praesidium/var/agents}"
export WRKQ_DB_PATH="${WRKQ_DB_PATH:-/Users/lherron/praesidium/var/db/wrkq.db}"
export ACP_WRKQ_DB_PATH="${ACP_WRKQ_DB_PATH:-$WRKQ_DB_PATH}"

send_result_email() {
  local status="$1"
  local output_path="$2"
  local body_path
  body_path="$(mktemp "${RUN_DIR}/acp-wrkq-refactor-email.XXXXXX")"

  {
    echo "ACP wrkq refactor automation result"
    echo
    echo "Status: ${status}"
    echo "Timestamp: $(timestamp)"
    echo "Target: ${TARGET}"
    echo "ScopeRef: ${TARGET_SCOPE_REF}"
    echo "LaneRef: main"
    echo "Repository: ${REPO_ROOT}"
    echo "HEAD: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo
    echo "Agent result:"
    if command -v jq >/dev/null 2>&1 && jq -e '.response.text' "$output_path" >/dev/null 2>&1; then
      jq -r '.response.text' "$output_path"
    else
      cat "$output_path"
    fi
  } >"$body_path"

  local subject="ACP wrkq refactor automation: ${status}"
  local gog_args=(
    send
    --account "$EMAIL_ACCOUNT"
    --no-input
    --to "$EMAIL_TO"
    --subject "$subject"
    --body-file "$body_path"
  )

  if [[ "${WRKQ_REFACTOR_EMAIL_DRY_RUN:-0}" == "1" || "${WRKQ_REFACTOR_SCHEDULED_DRY_RUN:-0}" == "1" ]]; then
    gog_args+=(--dry-run)
  fi

  echo "[$(timestamp)] emailing wrkq-refactor result to ${EMAIL_TO}"
  if gog "${gog_args[@]}"; then
    rm -f "$body_path"
    return 0
  fi

  echo "[$(timestamp)] failed to email wrkq-refactor result"
  echo "Email body retained at ${body_path}"
  return 1
}

if [[ "${WRKQ_REFACTOR_SCHEDULED_ALLOW_DIRTY:-0}" != "1" && -n "$(git status --porcelain)" ]]; then
  echo "[$(timestamp)] worktree is dirty; skipping scheduled refactor cycle"
  git status --short
  exit 0
fi

selection_output="$(mktemp "${RUN_DIR}/acp-wrkq-refactor-selection.XXXXXX")"
set +e
bun scripts/wrkq-refactor.ts next --json >"$selection_output" 2>&1
selection_status=$?
set -e

if [[ "$selection_status" -ne 0 ]]; then
  cat "$selection_output"

  if grep -q "No open tasks found under" "$selection_output"; then
    echo "[$(timestamp)] no open refactor task selected; skipping HRC turn"
    email_status=0
    send_result_email "skipped-no-task" "$selection_output" || email_status=$?
    rm -f "$selection_output"
    echo "[$(timestamp)] wrkq-refactor scheduled tick complete"
    exit "$email_status"
  fi

  echo "[$(timestamp)] refactor task selection failed; skipping HRC turn"
  email_status=0
  send_result_email "failed-selection" "$selection_output" || email_status=$?
  rm -f "$selection_output"
  if [[ "$email_status" -ne 0 ]]; then
    exit "$email_status"
  fi
  exit "$selection_status"
fi

if command -v jq >/dev/null 2>&1 && jq -e '.task.id' "$selection_output" >/dev/null 2>&1; then
  selected_task="$(jq -r '.task.id' "$selection_output")"
  echo "[$(timestamp)] selected refactor task ${selected_task}; starting HRC turn"
else
  echo "[$(timestamp)] selected refactor task; starting HRC turn"
fi
rm -f "$selection_output"

PROMPT=$(cat <<'PROMPT_EOF'
Run one ACP wrkq refactor automation cycle in /Users/lherron/praesidium/agent-control-plane.

This is a one-run HRC session. Use live repo and wrkq state; do not rely on prior session context.

Use the repo-local automation contract:
1. Run `bun scripts/wrkq-refactor.ts next`.
2. Read the selected task with `wrkq cat <task-id> --json` and read its referenced `refactor-analysis/*-report.md`.
3. Confirm the finding still matches the current source before editing.
4. If still valid, run `bun scripts/wrkq-refactor.ts start --task <task-id>`, implement the smallest behavior-preserving edit, run scoped checks plus repo checks appropriate to the touched surface, then run `bun scripts/wrkq-refactor.ts finish --task <task-id> --summary "<changes>" --validation "<checks>"`.
5. If the task is no longer valid, run `bun scripts/wrkq-refactor.ts archive --task <task-id> --reason "<why>"`.
6. If the task is review-required, unsafe, not behavior-preserving, or you otherwise choose not to proceed, run `bun scripts/wrkq-refactor.ts block --task <task-id> --reason "<why>"`. Do not leave the selected task open.
7. Final step: run `bun scripts/wrkq-refactor.ts publish --message "<commit message>"`.

Do not force review-required tasks. Do not batch multiple refactor tasks in one cycle. If blocked, mark the selected task blocked with the command above, publish, and report the blocker.
PROMPT_EOF
)

if [[ "${WRKQ_REFACTOR_SCHEDULED_DRY_RUN:-0}" == "1" ]]; then
  turn_output="$(mktemp "${RUN_DIR}/acp-wrkq-refactor-turn.XXXXXX")"
  set +e
  hrcchat turn --fresh-context --dry-run "$TARGET" "$PROMPT" >"$turn_output" 2>&1
  turn_status=$?
  set -e
else
  turn_output="$(mktemp "${RUN_DIR}/acp-wrkq-refactor-turn.XXXXXX")"
  set +e
  hrcchat turn --fresh-context --wait final --timeout 55m --quiet --json "$TARGET" "$PROMPT" >"$turn_output" 2>&1
  turn_status=$?
  set -e
fi

cat "$turn_output"

status_label="success"
if [[ "$turn_status" -ne 0 ]]; then
  status_label="failed"
fi

email_status=0
send_result_email "$status_label" "$turn_output" || email_status=$?
rm -f "$turn_output"

echo "[$(timestamp)] wrkq-refactor scheduled tick complete"

if [[ "$turn_status" -ne 0 ]]; then
  exit "$turn_status"
fi

if [[ "$email_status" -ne 0 ]]; then
  exit "$email_status"
fi
