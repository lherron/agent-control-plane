# Agent Spaces v2 justfile

# Default recipe
default:
    @just info
    @just --list

# Project information
info:
    @echo "Current Project: spaces"
    @echo "Description: Composable expertise modules, ASP registry"
    @echo "Stack:       TypeScript (Bun workspace)"
    @echo ""
    @echo "Key commands:"
    @echo "  just build     - Build all packages"
    @echo "  just test      - Run tests"
    @echo "  just lint      - Run biome linter"
    @echo "  just verify    - Run lint + typecheck + test"
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

# Run installed cap -> catalogd -> http-json -> live acp-server smoke for ACP caps
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

# Run all verification (check + lint + typecheck + test)
verify: check lint typecheck test

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

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
