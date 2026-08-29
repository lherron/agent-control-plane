#!/usr/bin/env bash
#
# dev-env.sh — provision and tear down the ephemeral environment the ACP suites
# need, from a fresh clone, using nothing but image substrate.
#
# WHY THIS EXISTS. agent-control-plane is a daemon project, and its suites are
# honest about it: acp-server's real-launcher / run-correlation / dispatch-fence
# tests reach `hrc-sdk discoverSocket()`, and the acp-e2e suites spawn the real
# `wrkf` and `wrkqadm` binaries against a freshly-migrated wrkq DB. Historically
# the daemon half was satisfied AMBIENTLY — by the operator's production HRC
# daemon at ~/praesidium/var/run/hrc/hrc.sock. That works on exactly one machine,
# and it means a green suite could be reporting on the health of the running
# system rather than on the tree under test. A fresh in-container clone showed
# what that was worth: 22 failures, all of them "HRC daemon socket not found"
# (T-06914 finding B).
#
# The build was the other half. Package `typecheck` reads sibling `dist/*.d.ts`,
# so the declared gate only passed on a checkout somebody had already built —
# `bun run build` was an undeclared prerequisite (T-06914 finding A, the same
# shape hrc-runtime found as T-06900). `env-up` owns it now.
#
# THE INVARIANT: everything lives under one root outside the checkout, and
# nothing here ever touches the host's production daemon, databases, or agents.
# In particular this script never starts the operator's acp-server or HRC
# LaunchAgent, and never opens ~/praesidium/var/db/acp-*.db.
#
#   env-up    idempotent, self-healing, prints what it started
#   env-down  teardown; env-up after a crashed env-down still works
#   run -- …  owns the environment for one command and always tears it down
#
# `just verify` — the declared landing gate — executes through `run`. So this
# script is load-bearing for landing, not a convenience: if it stops
# provisioning or reaping honestly, the gate stops meaning anything. Keep it
# boring.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One root per checkout, so two worktrees do not fight over one daemon. Kept
# under TMPDIR rather than in-tree because the unix socket paths underneath it
# are subject to the ~104-byte sockaddr limit, which a deep repo path can blow.
default_root() {
  local slug
  slug="$(printf '%s' "${REPO_ROOT}" | cksum | cut -d' ' -f1)"
  printf '%s/acp-dev-env-%s-%s' "${TMPDIR:-/tmp}" "$(id -u)" "${slug}"
}

ROOT="${ACP_DEV_ENV_ROOT:-$(default_root)}"
ROOT="${ROOT%/}"
HRC_RUN_DIR="${ROOT}/hrc-run"
HRC_STATE="${ROOT}/hrc-state"
AGENTS_DIR="${ROOT}/agents"
DB_DIR="${ROOT}/db"
ACP_RUN_DIR="${ROOT}/acp-run"
ASSETS_DIR="${ROOT}/assets/agents"
ENV_FILE="${ROOT}/env.sh"
HRC_PID_FILE="${ROOT}/hrc.pid"
HRC_LOG="${ROOT}/hrc.log"
ACP_PID_FILE="${ROOT}/acp.pid"
ACP_LOG="${ROOT}/acp.log"
PORT_FILE="${ROOT}/acp.port"
HRC_SOCKET="${HRC_RUN_DIR}/hrc.sock"
WRKQ_DB_FILE="${DB_DIR}/wrkq.db"
WRKF_HOOK_CATALOG_FILE="${ROOT}/empty-hook-catalog.json"
PROCESS_REGISTRY="${ROOT}/processes"

# A deliberately finite ceiling for manually provisioned roots. A successful
# `run` never reaches it because its EXIT trap tears down immediately; this is
# crash recovery for SIGKILL, host restarts, and older harness revisions that
# intentionally left their daemons behind.
STALE_AFTER_SECONDS=$((12 * 60 * 60))
TEARDOWN_ON_EXIT=0
RUN_CHILD_PID=""

# Every agent id the suites may address. A fixture home is a directory plus an
# agent-profile.toml — the marker spaces-config actually looks for; a bare
# directory resolves as "agent not found". This exists so nothing falls back to
# the operator's real ~/praesidium/var/agents.
FIXTURE_AGENTS=(
  cody clod rex larry smokey curly mable daedalus
  operator room-coordinator triage-runner human
)

log() { printf '[dev-env] %s\n' "$*"; }
die() { printf '[dev-env] ERROR: %s\n' "$*" >&2; exit 1; }

require_bin() {
  command -v "$1" >/dev/null 2>&1 || die "required binary '$1' not found on PATH ($2)"
}

process_group_id() {
  ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]'
}

register_process() {
  local kind="$1" pid="$2" pgid
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  kill -0 "${pid}" 2>/dev/null || return 0
  pgid="$(process_group_id "${pid}")"
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 0
  # Only session leaders establish a trusted daemon group. Descendants may
  # reuse that group after its ACP leader has been registered.
  if [[ "${kind}" == "hrc" || "${kind}" == "acp" ]]; then
    [[ "${pgid}" == "${pid}" ]] || return 0
  elif [[ ! -f "${PROCESS_REGISTRY}" ]] || ! awk -v pgid="${pgid}" '$1 == "acp" && $3 == pgid { found = 1 } END { exit !found }' "${PROCESS_REGISTRY}"; then
    return 0
  fi
  mkdir -p "${ROOT}"
  if [[ ! -f "${PROCESS_REGISTRY}" ]] || ! awk -v pid="${pid}" -v pgid="${pgid}" '$2 == pid && $3 == pgid { found = 1 } END { exit !found }' "${PROCESS_REGISTRY}"; then
    printf '%s %s %s\n' "${kind}" "${pid}" "${pgid}" >> "${PROCESS_REGISTRY}"
  fi
}

register_acp_descendants() {
  local parent_pid="$1" child command kind
  while IFS= read -r child; do
    [[ "${child}" =~ ^[0-9]+$ ]] || continue
    command="$(ps -o command= -p "${child}" 2>/dev/null || true)"
    kind="acp-child"
    [[ "${command}" == *wrkf* ]] && kind="wrkf"
    register_process "${kind}" "${child}"
    register_acp_descendants "${child}"
  done < <(pgrep -P "${parent_pid}" 2>/dev/null || true)
}

group_alive() {
  local pgid="$1"
  [[ "${pgid}" =~ ^[0-9]+$ ]] || return 1
  kill -0 -- "-${pgid}" 2>/dev/null
}

signal_registered_groups() {
  local root="$1" signal="$2" kind pid pgid own_pgid
  local registry="${root}/processes"
  [[ -f "${registry}" ]] || return 0
  own_pgid="$(process_group_id "$$")"
  while read -r kind pid pgid; do
    [[ "${pgid}" =~ ^[0-9]+$ ]] || continue
    # A corrupt/reused registry must never signal the harness's own process
    # group. Daemons are always launched in fresh sessions below.
    [[ "${pgid}" == "${own_pgid}" ]] && continue
    kill -"${signal}" -- "-${pgid}" 2>/dev/null || true
  done < "${registry}"
}

# Old revisions did not have a process-group registry. Find those survivors by
# the environment-owned root they inherited. The snapshot is private and
# short-lived because `ps eww` includes process environments.
root_process_pids() {
  local root="$1" snapshot shell_pid pid
  shell_pid="${BASHPID:-$$}"
  snapshot="$(mktemp "${TMPDIR:-/tmp}/acp-dev-env-ps.XXXXXX")"
  chmod 600 "${snapshot}"
  ps eww -axo pid=,command= > "${snapshot}"
  while IFS= read -r pid; do
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    kill -0 "${pid}" 2>/dev/null && printf '%s\n' "${pid}"
  done < <(awk -v self="$$" -v shell_pid="${shell_pid}" \
      -v marker="ACP_DEV_ENV_ROOT=${root}" \
      -v hrc_marker="HRC_RUNTIME_DIR=${root}/" \
      -v acp_marker="ACP_RUNTIME_DIR=${root}/" '
    $1 != self && $1 != shell_pid && (index($0, marker) || index($0, hrc_marker) || index($0, acp_marker)) { print $1 }
  ' "${snapshot}")
  rm -f "${snapshot}"
}

signal_root_processes() {
  local root="$1" signal="$2" pid
  while IFS= read -r pid; do
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    kill -"${signal}" "${pid}" 2>/dev/null || true
  done < <(root_process_pids "${root}")
}

registered_processes_alive() {
  local root="$1" kind pid pgid own_pgid
  local registry="${root}/processes"
  [[ -f "${registry}" ]] || return 1
  own_pgid="$(process_group_id "$$")"
  while read -r kind pid pgid; do
    [[ "${pgid}" == "${own_pgid}" ]] && continue
    group_alive "${pgid}" && return 0
  done < "${registry}"
  return 1
}

wait_for_root_exit() {
  local root="$1" waited=0
  while (( waited < 100 )); do
    if ! registered_processes_alive "${root}" && [[ -z "$(root_process_pids "${root}")" ]]; then
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  return 1
}

teardown_root() {
  local root="$1" survivors
  [[ -d "${root}" ]] || return 0

  signal_registered_groups "${root}" TERM
  signal_root_processes "${root}" TERM
  if ! wait_for_root_exit "${root}"; then
    signal_registered_groups "${root}" KILL
    signal_root_processes "${root}" KILL
    wait_for_root_exit "${root}" || true
  fi

  if [[ -S "${root}/hrc-run/tmux.sock" ]]; then
    tmux -S "${root}/hrc-run/tmux.sock" kill-server 2>/dev/null || true
  fi

  survivors="$(root_process_pids "${root}")"
  if registered_processes_alive "${root}" || [[ -n "${survivors}" ]]; then
    log "ERROR: processes survived teardown for ${root}: ${survivors:-registered process group}" >&2
    return 1
  fi

  rm -rf "${root}"
}

root_mtime() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null
}

root_has_dead_recorded_pid() {
  local root="$1" pid_file pid found=0 kind pgid
  for pid_file in "${root}/owner.pid" "${root}/hrc.pid" "${root}/acp.pid"; do
    [[ -f "${pid_file}" ]] || continue
    found=1
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null || return 0
  done
  if [[ -f "${root}/processes" ]]; then
    while read -r kind pid pgid; do
      found=1
      [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null || return 0
    done < "${root}/processes"
  fi
  [[ "${found}" == 0 ]] && return 0
  return 1
}

sweep_stale_roots() {
  local base candidate now modified age
  base="${TMPDIR:-/tmp}"
  base="${base%/}"
  now="$(date +%s)"
  for candidate in "${base}"/acp-dev-env-"$(id -u)"-*; do
    [[ -d "${candidate}" ]] || continue
    modified="$(root_mtime "${candidate}" || true)"
    [[ "${modified}" =~ ^[0-9]+$ ]] || modified="${now}"
    age=$((now - modified))
    if root_has_dead_recorded_pid "${candidate}" || (( age >= STALE_AFTER_SECONDS )); then
      log "sweeping stale environment ${candidate} (age ${age}s)"
      teardown_root "${candidate}"
    fi
  done
}

cleanup_on_exit() {
  local status="$?" cleanup_status=0
  trap - EXIT INT TERM HUP
  if [[ -n "${RUN_CHILD_PID}" ]] && kill -0 "${RUN_CHILD_PID}" 2>/dev/null; then
    kill -TERM "${RUN_CHILD_PID}" 2>/dev/null || true
    wait "${RUN_CHILD_PID}" 2>/dev/null || true
  fi
  if (( TEARDOWN_ON_EXIT )); then
    teardown_root "${ROOT}" || cleanup_status=$?
  fi
  if (( status == 0 && cleanup_status != 0 )); then
    status="${cleanup_status}"
  fi
  exit "${status}"
}

handle_signal() {
  local signal="$1" status="$2"
  if [[ -n "${RUN_CHILD_PID}" ]] && kill -0 "${RUN_CHILD_PID}" 2>/dev/null; then
    kill -"${signal}" "${RUN_CHILD_PID}" 2>/dev/null || true
  fi
  exit "${status}"
}

trap cleanup_on_exit EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal HUP 129' HUP

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# env-up owns the build. It is UNCONDITIONAL, not "build if dist is missing":
# a present-but-stale dist — after a pull, a branch switch, a revert — is the
# same class of bug as no dist at all, because the gate would then read state
# left behind by earlier work instead of deriving it from the tree. It costs
# ~19s.
#
# `bun install` stays conditional. This repo pulls dependencies explicitly via
# `just pull-deps` and treats bun.lock as something a gate must never advance,
# so the install here covers only the case it has to: a clone with no
# node_modules at all.
provision_build() {
  if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
    log "installing dependencies (bun install)"
    (cd "${REPO_ROOT}" && bun install)
  fi
  log "building workspace (bun run build)"
  (cd "${REPO_ROOT}" && bun run build)
}

provision_agents() {
  local agent
  for agent in "${FIXTURE_AGENTS[@]}"; do
    mkdir -p "${AGENTS_DIR}/${agent}"
    cat > "${AGENTS_DIR}/${agent}/agent-profile.toml" <<EOF
schemaVersion = 2

[identity]
display = "${agent}"
role = "fixture"
harness = "codex"
EOF
  done
}

# A migrated wrkq DB the ephemeral acp-server can open. The suites that spawn
# real wrkf create their OWN throwaway DBs per test; this one exists so the
# daemon has a locator that is not the canonical ~/praesidium/var/db/wrkq.db.
provision_wrkq_db() {
  mkdir -p "${DB_DIR}"
  if [[ ! -f "${WRKQ_DB_FILE}" ]]; then
    log "initializing ephemeral wrkq db (${WRKQ_DB_FILE})"
    "${WRKQADM_BIN:-wrkqadm}" --db "${WRKQ_DB_FILE}" init >/dev/null
  fi
  # env-up is reusable across dependency bumps. An existing ephemeral DB may
  # predate the currently installed wrkq binary, so initialization alone is
  # insufficient: always apply any pending migrations before ACP opens it.
  "${WRKQADM_BIN:-wrkqadm}" --db "${WRKQ_DB_FILE}" migrate >/dev/null
}

# Local wrkf RPC now fails closed unless its hook authority is explicit. The
# ephemeral ACP gate does not execute external hooks, so give both the daemon
# and real-process tests a deliberately empty, environment-owned catalog.
provision_wrkf_hook_catalog() {
  printf '%s\n' '{"schemaVersion":"wrkf.hook-catalog.v0","hooks":{}}' > "${WRKF_HOOK_CATALOG_FILE}"
}

# ---------------------------------------------------------------------------
# HRC daemon
# ---------------------------------------------------------------------------

# Liveness is the socket ANSWERING, not the socket existing: a crashed daemon
# leaves the inode behind, and treating that as "up" is how env-up stops being
# self-healing.
hrc_responds() {
  HRC_RUNTIME_DIR="${HRC_RUN_DIR}" HRC_STATE_DIR="${HRC_STATE}" \
    hrc server status --json >/dev/null 2>&1
}

# `hrc server serve`, never `hrc server start`. `start` probes launchd and
# kickstarts the LaunchAgent when one is loaded — on a developer laptop that
# would start (or restart) the operator's PRODUCTION daemon and ignore the
# HRC_RUNTIME_DIR pointing at our temp root. `serve` is the launchd-free
# foreground path, so we supervise it ourselves and know exactly what we killed.
# (Carried verbatim from hrc-runtime's dev-env.sh; it was learned there.)
start_hrc() {
  if hrc_responds; then
    log "HRC daemon already healthy on ${HRC_SOCKET} (reused)"
    register_process hrc "$(cat "${HRC_PID_FILE}" 2>/dev/null || cat "${HRC_RUN_DIR}/server.pid" 2>/dev/null || true)"
    return 0
  fi

  if [[ -e "${HRC_SOCKET}" || -f "${HRC_PID_FILE}" ]]; then
    log "clearing stale HRC residue under ${HRC_RUN_DIR}"
    stop_hrc
  fi

  mkdir -p "${HRC_RUN_DIR}" "${HRC_STATE}"
  log "starting ephemeral HRC daemon (hrc server serve) → ${HRC_LOG}"
  (
    cd "${REPO_ROOT}"
    ACP_DEV_ENV_ROOT="${ROOT}" HRC_RUNTIME_DIR="${HRC_RUN_DIR}" HRC_STATE_DIR="${HRC_STATE}" ASP_AGENTS_ROOT="${AGENTS_DIR}" \
      nohup perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' \
        hrc server serve >"${HRC_LOG}" 2>&1 &
    printf '%s\n' "$!" > "${HRC_PID_FILE}"
  )
  register_process hrc "$(cat "${HRC_PID_FILE}")"

  local waited=0
  while (( waited < 60 )); do
    if hrc_responds; then
      register_process hrc "$(cat "${HRC_PID_FILE}")"
      log "HRC daemon healthy (pid $(cat "${HRC_PID_FILE}"))"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  tail -20 "${HRC_LOG}" >&2 || true
  die "ephemeral HRC daemon did not become healthy within ${waited}s"
}

stop_hrc() {
  kill_pidfile "${HRC_PID_FILE}"
  # The daemon owns a tmux server on its own socket; killing the daemon does not
  # reap it, and a leaked tmux server keeps panes (and their processes) alive.
  if [[ -S "${HRC_RUN_DIR}/tmux.sock" ]]; then
    tmux -S "${HRC_RUN_DIR}/tmux.sock" kill-server 2>/dev/null || true
  fi
  rm -f "${HRC_SOCKET}" "${HRC_RUN_DIR}/server.lock" "${HRC_RUN_DIR}/server.pid" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# ACP daemon
# ---------------------------------------------------------------------------

# Never the plist port. 18470 is the operator's live acp-server; binding it here
# would either fail or, worse, succeed against a stopped production daemon and
# let a suite talk to something it did not provision.
pick_port() {
  if [[ -f "${PORT_FILE}" ]]; then
    cat "${PORT_FILE}"
    return 0
  fi
  local port
  port="$(bun -e '
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    console.log(server.port)
    server.stop(true)
  ')"
  [[ -n "${port}" ]] || die "could not allocate a free port for acp-server"
  printf '%s\n' "${port}" > "${PORT_FILE}"
  printf '%s\n' "${port}"
}

acp_responds() {
  local port="$1"
  curl -fsS -m 2 "http://127.0.0.1:${port}/v1/mobile/health" >/dev/null 2>&1
}

start_acp() {
  local port
  port="$(pick_port)"

  if acp_responds "${port}"; then
    log "acp-server already healthy on 127.0.0.1:${port} (reused)"
    register_process acp "$(cat "${ACP_PID_FILE}" 2>/dev/null || true)"
    register_acp_descendants "$(cat "${ACP_PID_FILE}" 2>/dev/null || true)"
    return 0
  fi

  if [[ -f "${ACP_PID_FILE}" ]]; then
    log "clearing stale acp-server residue"
    kill_pidfile "${ACP_PID_FILE}"
  fi

  mkdir -p "${ACP_RUN_DIR}" "${ASSETS_DIR}"
  log "starting ephemeral acp-server on 127.0.0.1:${port} → ${ACP_LOG}"
  (
    cd "${REPO_ROOT}"
    ACP_HOST=127.0.0.1 \
    ACP_PORT="${port}" \
    ACP_WRKQ_DB="${WRKQ_DB_FILE}" \
    ACP_COORD_DB_PATH="${DB_DIR}/acp-coordination.db" \
    ACP_INTERFACE_DB_PATH="${DB_DIR}/acp-interface.db" \
    ACP_STATE_DB_PATH="${DB_DIR}/acp-state.db" \
    ACP_ADMIN_DB_PATH="${DB_DIR}/acp-admin.db" \
    ACP_JOBS_DB_PATH="${DB_DIR}/acp-jobs.db" \
    ACP_CONVERSATION_DB_PATH="${DB_DIR}/acp-conversation.db" \
    ACP_AGENT_ASSETS_DIR="${ASSETS_DIR}" \
    ACP_RUNTIME_DIR="${ACP_RUN_DIR}" \
    ACP_CAP_CATALOG_STATE_DIR="${ROOT}/cap-catalog" \
    WRKF_HOOK_CATALOG="${WRKF_HOOK_CATALOG_FILE}" \
    HRC_RUNTIME_DIR="${HRC_RUN_DIR}" \
    HRC_STATE_DIR="${HRC_STATE}" \
    ASP_AGENTS_ROOT="${AGENTS_DIR}" \
    ACP_DEV_ENV_ROOT="${ROOT}" \
      nohup perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' \
        bun "${REPO_ROOT}/packages/acp-server/src/cli.ts" >"${ACP_LOG}" 2>&1 &
    printf '%s\n' "$!" > "${ACP_PID_FILE}"
  )
  register_process acp "$(cat "${ACP_PID_FILE}")"

  local waited=0
  while (( waited < 60 )); do
    if acp_responds "${port}"; then
      register_process acp "$(cat "${ACP_PID_FILE}")"
      register_acp_descendants "$(cat "${ACP_PID_FILE}")"
      log "acp-server healthy (pid $(cat "${ACP_PID_FILE}"))"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  tail -20 "${ACP_LOG}" >&2 || true
  die "ephemeral acp-server did not become healthy within ${waited}s"
}

# ---------------------------------------------------------------------------
# Shared lifecycle
# ---------------------------------------------------------------------------

# Teardown is unconditional and never fails: it has to work on a half-created
# root, on a root whose daemons are already gone, and on a root that a previous
# crashed env-down left behind.
kill_pidfile() {
  local pid_file="$1" pid waited=0
  [[ -f "${pid_file}" ]] || return 0
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    while (( waited < 10 )) && kill -0 "${pid}" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${pid_file}"
}

write_env_file() {
  local port
  port="$(cat "${PORT_FILE}")"
  cat > "${ENV_FILE}" <<EOF
# Generated by scripts/dev-env.sh — source this to point a shell at the
# ephemeral environment. Never exported globally by the recipes themselves.
export ACP_DEV_ENV_ROOT='${ROOT}'
export HRC_RUNTIME_DIR='${HRC_RUN_DIR}'
export HRC_STATE_DIR='${HRC_STATE}'
export ASP_AGENTS_ROOT='${AGENTS_DIR}'
export ASP_PROJECT='agent-control-plane'
export WRKQ_DB='${WRKQ_DB_FILE}'
export ACP_WRKQ_DB='${WRKQ_DB_FILE}'
export WRKF_HOOK_CATALOG='${WRKF_HOOK_CATALOG_FILE}'
export ACP_BASE_URL='http://127.0.0.1:${port}'
export ACP_PORT='${port}'
export ACP_INTERFACE_DB_PATH='${DB_DIR}/acp-interface.db'
export ACP_STATE_DB_PATH='${DB_DIR}/acp-state.db'
export ACP_COORD_DB_PATH='${DB_DIR}/acp-coordination.db'
export ACP_AGENT_ASSETS_DIR='${ASSETS_DIR}'
export ACP_RUNTIME_DIR='${ACP_RUN_DIR}'
EOF
}

cmd_up() {
  require_bin bun 'image substrate'
  require_bin hrc 'installed by install-praesidium.sh'
  require_bin curl 'image substrate'
  require_bin "${WRKQADM_BIN:-wrkqadm}" 'devbox:base >= 286ecea0 bakes it at /usr/local/bin'

  TEARDOWN_ON_EXIT=1
  sweep_stale_roots
  mkdir -p "${ROOT}" "${HRC_RUN_DIR}" "${HRC_STATE}" "${AGENTS_DIR}" "${DB_DIR}" "${ACP_RUN_DIR}" "${ASSETS_DIR}"
  printf '%s\n' "$$" > "${ROOT}/owner.pid"
  provision_build
  provision_agents
  provision_wrkq_db
  provision_wrkf_hook_catalog
  start_hrc
  start_acp
  write_env_file

  log "environment ready"
  log "  root         ${ROOT}"
  log "  HRC runtime  ${HRC_RUN_DIR}   (HRC_RUNTIME_DIR)"
  log "  HRC state    ${HRC_STATE}   (HRC_STATE_DIR)"
  log "  agents root  ${AGENTS_DIR}   (ASP_AGENTS_ROOT, ${#FIXTURE_AGENTS[@]} fixture homes)"
  log "  wrkq db      ${WRKQ_DB_FILE}   (WRKQ_DB)"
  log "  acp dbs      ${DB_DIR}/acp-*.db"
  log "  HRC daemon   ${HRC_SOCKET}  pid $(cat "${HRC_PID_FILE}" 2>/dev/null || echo '?')"
  log "  acp-server   http://127.0.0.1:$(cat "${PORT_FILE}")  pid $(cat "${ACP_PID_FILE}" 2>/dev/null || echo '?')"
  log "  logs         ${HRC_LOG} ${ACP_LOG}"
  log "  env file     ${ENV_FILE}   (source it to point a shell here)"
  rm -f "${ROOT}/owner.pid"
  TEARDOWN_ON_EXIT=0
}

cmd_down() {
  if [[ ! -d "${ROOT}" ]]; then
    log "nothing to tear down (${ROOT} absent)"
    return 0
  fi
  teardown_root "${ROOT}"
  log "environment removed (${ROOT})"
}

cmd_run() {
  [[ "${1:-}" == "--" ]] && shift
  (( $# > 0 )) || die "usage: dev-env.sh run -- <command> [args...]"

  TEARDOWN_ON_EXIT=1
  cmd_up
  # cmd_up disarms failure-only cleanup after success; the owned run immediately
  # rearms it for success, command failure, and signals.
  TEARDOWN_ON_EXIT=1
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
  "$@" &
  RUN_CHILD_PID="$!"
  wait "${RUN_CHILD_PID}"
  local status="$?"
  RUN_CHILD_PID=""
  return "${status}"
}

# Print the exports so a caller can `eval "$(scripts/dev-env.sh env)"` without
# knowing where the root landed.
cmd_env() {
  [[ -f "${ENV_FILE}" ]] || die "no environment provisioned; run 'just env-up' first"
  cat "${ENV_FILE}"
}

case "${1:-}" in
  up)   cmd_up ;;
  down) cmd_down ;;
  env)  cmd_env ;;
  run)  shift; cmd_run "$@" ;;
  *)    die "usage: dev-env.sh <up|down|env|run -- command...>" ;;
esac
