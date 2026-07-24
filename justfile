# Agent Spaces v2 justfile

# Default recipe
default:
    @just info
    @just --list

# Project information
info:
    @echo "Current Project: agent-control-plane"
    @echo "Description: ACP workflow kernel, control-plane state, HTTP server, interface gateways"
    @echo "Stack:       TypeScript (Bun workspace)"
    @echo ""
    @echo "Key commands:"
    @echo "  just build     - Build all packages"
    @echo "  just test      - Run tests"
    @echo "  just lint      - Run biome linter"
    @echo "  just verify    - Declared landing gate: env-up + architecture + check + lint + typecheck + test"
    @echo "  just env-up    - Provision the ephemeral HRC daemon, acp-server, and wrkq DB"
    @echo "  just env-down  - Tear that environment down"
    @echo "  just e2e       - Run the acp-e2e suite against the provisioned environment"
    @echo "  just install   - Install deps, materialize Git hooks, build, and link binaries"

# Build all packages
build:
    bun run build

# Run tests
test:
    bun run test

# Run integration tests
test-integration:
    bun run test:integration

# Run linter
lint:
    bun run lint

# Fix lint issues
lint-fix:
    bun run lint:fix

# Run type checker
typecheck:
    bun run typecheck

# Run suppression, repo-split boundary, manifest edge, CLI, public surface, and enablement changelog checks
check:
    bun scripts/check-suppressions.ts
    bun scripts/check-boundaries.ts
    bun scripts/check-manifest-edges.ts
    bun scripts/check-cli-surface.ts
    bun scripts/check-public-surface.ts
    bun scripts/check-enablement-changelog.ts

# Validate reviewed suppression inventory
check-suppressions:
    bun scripts/check-suppressions.ts

# Validate public package, CLI, API, capability, and doc surface freshness
check-public-surface:
    bun scripts/check-public-surface.ts

# Validate ACP CLI docs/live Commander surface freshness
check-cli-surface:
    bun scripts/check-cli-surface.ts

# Validate append-only enablement lesson routing record
check-enablement-changelog:
    bun scripts/check-enablement-changelog.ts

# Run installed cap -> catalogd -> http-json -> live acp-server smoke for ACP caps.
# NOT hermetic and deliberately not part of `just e2e`: `cap` and `catalogd`
# resolve only to the unpublished sibling repo ~/praesidium/semantic-capabilities
# and are in no ACP dependency, so this cannot run from a fresh clone. See
# T-06914 finding E for the open ruling.
e2e-cap-acp:
    scripts/e2e/cap-acp/smoke.sh

# Manually run ACP smoke paths that enqueue real HRC agent turns
e2e-cap-acp-real:
    CAP_ACP_E2E_REAL_AGENT=1 scripts/e2e/cap-acp/smoke.sh

# Manually run ACP smoke with cap-pbc enabled; creates real wrkq tasks and agent turns
e2e-cap-pbc:
    CAP_PBC_E2E=1 CAP_ACP_E2E_REAL_AGENT=1 scripts/e2e/cap-acp/smoke.sh

# Prepare or update one wrkq refactor-deferred task work packet
# (Scheduling is handled by the ACP-native schedule at
#  var/agents/cody/schedules/wrkq-refactor.toml — the old LaunchAgent wrapper
#  was removed.)
wrkq-refactor *args:
    bun scripts/wrkq-refactor.ts {{args}}

# Validate durable architecture records and generated projections
architecture-records *args:
    bun scripts/check-architecture-records.ts {{args}}

# The declared landing gate. It depends on `env-up` because the gate provisions
# the environment it needs instead of inheriting it (T-06914, applying the
# hrc-runtime ruling T-06900 + T-06902). Before this, a green `just verify` was
# partly a statement about the operator's live production HRC daemon rather than
# about the tree under test — strictly worse than merely non-hermetic. `env-up`
# also owns `bun run build`, which `typecheck` has always required (it reads
# sibling dist/*.d.ts) and the gate never declared.

# Written as a SCRIPT rather than a dependency list (`verify: env-up check …`)
# because just runs each dependency in its OWN shell: env-up would provision the
# environment and then none of the stages would see it. That shape looks right
# and fails the proof. The eval is what actually connects the two.

# `architecture-records` stays a declared dependency rather than moving into the
# body: it needs no provisioned environment, and scripts/check-architecture-records.ts
# asserts that `verify` lists it (a durable-records guard that a script body
# would silently satisfy-by-looking-right). The stages that DO need the
# environment live in the body below.

# Run all verification (env-up + architecture + check + lint + typecheck + test)
verify: env-up architecture-records
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bash scripts/dev-env.sh env)"
    just check
    just lint
    just typecheck
    just test

# -- Ephemeral development environment (T-06914) -----------------------------
#
# agent-control-plane is a daemon project, so "the environment the suite needs"
# is a running daemon and a migrated database — not a port and a fixture dir.
# Both were satisfied ambiently until now (the operator's HRC daemon at
# ~/praesidium/var/run/hrc, the operator's DBs under ~/praesidium/var/db), which
# is why the suite was green on exactly one machine. `env-up` provisions an
# ephemeral HRC daemon, an ephemeral acp-server, and an ephemeral wrkq DB under
# one temp root and touches none of the real ones. See scripts/dev-env.sh for
# the why in full.
#
# `env-up` leaves its daemons running on purpose — a second `env-up` reuses
# them, so back-to-back `just verify` / `just e2e` do not pay for a restart.
# Reap them with `just env-down` when you are done for the day.

# Provision the ephemeral e2e environment (idempotent, self-healing)
env-up:
    bash scripts/dev-env.sh up

# Tear the ephemeral e2e environment down (safe on a half-built or crashed root)
env-down:
    bash scripts/dev-env.sh down

# The e2e suite is `acp-e2e` run against REAL provisioned infrastructure: the
# real `wrkf`/`wrkqadm` binaries over freshly-migrated wrkq DBs, and a real HRC
# daemon that mints real host sessions. Running it any other way tests a mock of
# the thing rather than the thing.
#
# NOT included: `just e2e-cap-acp`, the cap→catalogd→acp-server capability
# smoke. It cannot run from a fresh clone anywhere — `cap` and `catalogd` live
# only in the unpublished sibling repo ~/praesidium/semantic-capabilities and
# appear in no ACP dependency. That is a design question (T-06914 finding E),
# filed rather than papered over; folding it in here would make `e2e` mean
# "green on the operator's laptop" again.

# Run the e2e suite against the ephemeral environment
e2e: env-up
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(bash scripts/dev-env.sh env)"
    echo "[e2e] acp-server ${ACP_BASE_URL}, HRC ${HRC_RUNTIME_DIR}/hrc.sock, wrkq ${WRKQ_DB}"
    # Prove the provisioned daemon is the one answering before trusting the suite.
    curl -fsS "${ACP_BASE_URL}/v1/mobile/health" >/dev/null
    echo "[e2e] acp-server health ok"
    bun run --filter 'acp-e2e' test

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

# Explicitly advance locally-published dependency pins and create one lockfile-only commit.
pull-deps:
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --quiet -- bun.lock && git diff --cached --quiet -- bun.lock || { echo "pull-deps: bun.lock must be clean before pulling" >&2; exit 1; }
    PRAESIDIUM_SYNC_NO_COMMIT=1 bun scripts/sync-asp-from-verdaccio.ts --pull
    PRAESIDIUM_SYNC_NO_COMMIT=1 bun scripts/sync-wrkq-from-verdaccio.ts --pull
    bun scripts/commit-verdaccio-lock.ts

# Advisory and read-only.
check-deps:
    bun scripts/sync-asp-from-verdaccio.ts --check
    bun scripts/sync-wrkq-from-verdaccio.ts --check

# Install dependencies
# Linked Git worktrees auto-disable wrapper linking and publish to an isolated worktree
# artifact channel. Pass force-link=1 only when intentionally repointing local wrappers
# from a linked worktree.
install no-sync="" force-sync="" force-link="":
    #!/usr/bin/env bash
    set -euo pipefail
    repo_root="$(git rev-parse --show-toplevel)"
    eval "$(bun scripts/install-policy.ts shell --no-sync="{{ no-sync }}" --force-sync="{{ force-sync }}" --force-link="{{ force-link }}")"
    echo "[install] context=${PRAESIDIUM_INSTALL_CONTEXT} sync=${PRAESIDIUM_INSTALL_SYNC_MODE} link=${PRAESIDIUM_INSTALL_LINK_MODE} publish=${PRAESIDIUM_INSTALL_PUBLISH_CHANNEL} tag=${PRAESIDIUM_INSTALL_PUBLISH_TAG}"
    bun run clean
    bun install
    bun run install:hooks
    bun run build
    if [ "$PRAESIDIUM_INSTALL_PUBLISH_CHANNEL" = "worktree" ]; then
      just publish-worktree
    else
      just publish-dev
    fi
    if [ "$PRAESIDIUM_INSTALL_LINK_MODE" != "off" ]; then
      if [ "$PRAESIDIUM_INSTALL_LINK_MODE" = "forced" ]; then
        echo "[install] WARNING: force-link enabled from ${PRAESIDIUM_INSTALL_CONTEXT}; updating local ACP wrappers"
      fi
      ( cd "$repo_root/packages/acp-cli" && bun link )
      ( cd "$repo_root/packages/acp-server" && bun link )
      ( cd "$repo_root/packages/wlearn" && bun link )
    else
      echo "[install] skipping bun link; linked worktree installs must not update local ACP wrappers"
    fi

# Publish ordinary ACP package versions to local Verdaccio
publish-dev:
    bun scripts/publish-local-verdaccio.ts

# Validate ordinary ACP package publication without publishing
publish-dev-dry-run:
    bun scripts/publish-local-verdaccio.ts --dry-run

# Publish isolated linked-worktree ACP package versions to local Verdaccio
publish-worktree:
    bun scripts/publish-local-verdaccio.ts --channel worktree

# Validate isolated linked-worktree ACP package versions without publishing
publish-worktree-dry-run:
    bun scripts/publish-local-verdaccio.ts --channel worktree --dry-run

# Serve the ACP viewer (live sessions dashboard at /sessions) against the local dev stack
serve-dashboard:
    cd packages/acp-viewer && bun run dev

# Run control-plane interface test with rex-home target
cp-test prompt="List skills available. Use only what is in your context, no tools.":
    ASP_HOME=/Users/lherron/praesidium/var/spaces-repo bun scripts/cp-interface-test.ts \
        --target default \
        --target-dir /Users/lherron/praesidium/rex-home \
        --model claude/sonnet \
        "{{prompt}}"
