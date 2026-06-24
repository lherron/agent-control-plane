#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${WRKQ_REFACTOR_REPO_ROOT:-/Users/lherron/praesidium/agent-control-plane}"
LOG_DIR="${WRKQ_REFACTOR_LOG_DIR:-/Users/lherron/praesidium/var/logs}"
RUN_DIR="${WRKQ_REFACTOR_RUN_DIR:-/Users/lherron/praesidium/var/run}"
LOCK_DIR="${RUN_DIR}/acp-wrkq-refactor.lock"
LOG_PATH="${LOG_DIR}/acp-wrkq-refactor.log"

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

if [[ "${WRKQ_REFACTOR_SCHEDULED_ALLOW_DIRTY:-0}" != "1" && -n "$(git status --porcelain)" ]]; then
  echo "[$(timestamp)] worktree is dirty; skipping scheduled refactor cycle"
  git status --short
  exit 0
fi

PROMPT=$(cat <<'PROMPT_EOF'
Run one ACP wrkq refactor automation cycle in /Users/lherron/praesidium/agent-control-plane.

Use the repo-local automation contract:
1. Run `bun scripts/wrkq-refactor.ts next`.
2. Read the selected task with `wrkq cat <task-id> --json` and read its referenced `refactor-analysis/*-report.md`.
3. Confirm the finding still matches the current source before editing.
4. If still valid, run `bun scripts/wrkq-refactor.ts start --task <task-id>`, implement the smallest behavior-preserving edit, run scoped checks plus repo checks appropriate to the touched surface, then run `bun scripts/wrkq-refactor.ts finish --task <task-id> --summary "<changes>" --validation "<checks>"`.
5. If the task is no longer valid, run `bun scripts/wrkq-refactor.ts archive --task <task-id> --reason "<why>"`.
6. Final step: run `bun scripts/wrkq-refactor.ts publish --message "<commit message>"`.

Do not force review-required tasks. Do not batch multiple refactor tasks in one cycle. If blocked, leave the task untouched and report the blocker.
PROMPT_EOF
)

if [[ "${WRKQ_REFACTOR_SCHEDULED_DRY_RUN:-0}" == "1" ]]; then
  hrcchat turn --dry-run cody@agent-control-plane:primary "$PROMPT"
else
  hrcchat turn --wait final --timeout 55m --quiet --json cody@agent-control-plane:primary "$PROMPT"
fi

echo "[$(timestamp)] wrkq-refactor scheduled tick complete"
