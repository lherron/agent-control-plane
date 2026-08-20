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
#
# `just verify` — the declared landing gate — depends on env-up. So this script
# is load-bearing for landing, not a convenience: if it stops provisioning
# honestly, the gate stops meaning anything. Keep it boring.

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
  if [[ -f "${WRKQ_DB_FILE}" ]]; then
    return 0
  fi
  log "initializing ephemeral wrkq db (${WRKQ_DB_FILE})"
  "${WRKQADM_BIN:-wrkqadm}" --db "${WRKQ_DB_FILE}" init >/dev/null
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
    HRC_RUNTIME_DIR="${HRC_RUN_DIR}" HRC_STATE_DIR="${HRC_STATE}" ASP_AGENTS_ROOT="${AGENTS_DIR}" \
      nohup hrc server serve >"${HRC_LOG}" 2>&1 &
    printf '%s\n' "$!" > "${HRC_PID_FILE}"
  )

  local waited=0
  while (( waited < 60 )); do
    hrc_responds && { log "HRC daemon healthy (pid $(cat "${HRC_PID_FILE}"))"; return 0; }
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
      nohup bun "${REPO_ROOT}/packages/acp-server/src/cli.ts" >"${ACP_LOG}" 2>&1 &
    printf '%s\n' "$!" > "${ACP_PID_FILE}"
  )

  local waited=0
  while (( waited < 60 )); do
    acp_responds "${port}" && { log "acp-server healthy (pid $(cat "${ACP_PID_FILE}"))"; return 0; }
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

  mkdir -p "${ROOT}" "${HRC_RUN_DIR}" "${HRC_STATE}" "${AGENTS_DIR}" "${DB_DIR}" "${ACP_RUN_DIR}" "${ASSETS_DIR}"
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
}

cmd_down() {
  if [[ ! -d "${ROOT}" ]]; then
    log "nothing to tear down (${ROOT} absent)"
    return 0
  fi
  kill_pidfile "${ACP_PID_FILE}"
  stop_hrc
  rm -rf "${ROOT}"
  log "environment removed (${ROOT})"
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
  *)    die "usage: dev-env.sh <up|down|env>" ;;
esac
