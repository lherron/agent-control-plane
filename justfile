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

# Run repo-split boundary + manifest edge checks
check:
    bun scripts/check-boundaries.ts
    bun scripts/check-manifest-edges.ts

# Run installed cap -> catalogd -> http-json -> live acp-server smoke for all ACP/PBC caps
e2e-cap-acp:
    scripts/e2e/cap-acp/smoke.sh

# Prepare or update one wrkq refactor-deferred task work packet
wrkq-refactor *args:
    bun scripts/wrkq-refactor.ts {{args}}

# Dry-run the scheduled wrkq refactor automation turn without dispatching an agent
wrkq-refactor-schedule-dry-run:
    WRKQ_REFACTOR_SCHEDULED_DRY_RUN=1 WRKQ_REFACTOR_SCHEDULED_ALLOW_DIRTY=1 scripts/wrkq-refactor-scheduled.sh

# Install the wrkq refactor automation LaunchAgent (runs every 20 minutes)
wrkq-refactor-schedule-install:
    mkdir -p "$HOME/Library/LaunchAgents"
    cp launchd/com.praesidium.acp-wrkq-refactor.plist "$HOME/Library/LaunchAgents/com.praesidium.acp-wrkq-refactor.plist"
    -launchctl bootout gui/$(id -u)/com.praesidium.acp-wrkq-refactor
    launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.praesidium.acp-wrkq-refactor.plist"
    launchctl enable gui/$(id -u)/com.praesidium.acp-wrkq-refactor
    launchctl print gui/$(id -u)/com.praesidium.acp-wrkq-refactor

# Show the installed wrkq refactor automation LaunchAgent state
wrkq-refactor-schedule-status:
    launchctl print gui/$(id -u)/com.praesidium.acp-wrkq-refactor

# Uninstall the wrkq refactor automation LaunchAgent
wrkq-refactor-schedule-uninstall:
    -launchctl bootout gui/$(id -u)/com.praesidium.acp-wrkq-refactor
    rm -f "$HOME/Library/LaunchAgents/com.praesidium.acp-wrkq-refactor.plist"

# Run all verification (check + lint + typecheck + test)
verify: check lint typecheck test

# Clean build artifacts
clean:
    bun run clean

# Rebuild from scratch
rebuild:
    bun run rebuild

# Install dependencies
install:
    bun run clean
    bun install
    bun run build
    bun scripts/publish-local-verdaccio.ts
    cd packages/acp-cli && bun link
    cd packages/acp-server && bun link
    cd packages/wlearn && bun link

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
