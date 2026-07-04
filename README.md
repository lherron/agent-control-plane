# Agent Control Plane

Agent Control Plane (ACP) is the local control-plane layer for Praesidium agents,
sessions, jobs, gateway surfaces, and wrkf-backed task lifecycle facades.

The current implementation source of truth is
[docs/agent-control-plane-current-spec.md](docs/agent-control-plane-current-spec.md).
Agent/operator runtime rules live in [AGENTS.md](AGENTS.md). Use those documents
for detailed operational behavior; this README is only the repo entry point.

## Quick Start

Prerequisites: Bun, Just, the local Praesidium dev stack, and the local Verdaccio
registry at `http://127.0.0.1:4873/` for ASP/HRC workspace dependencies.

```bash
bun install
bun run build
acp server status --json
```

The installed ACP server normally listens on `http://127.0.0.1:18470`.

## Usage

Use the installed `acp` CLI for operator workflows and runtime inspection:

```bash
acp --help
acp server status --json
```

For live route, package, CLI, and public-surface discovery from this checkout:

```bash
bun scripts/discover-acp.ts all --json
```

Package-level details:

- CLI usage: [packages/acp-cli/README.md](packages/acp-cli/README.md)
- Server routes and runtime config:
  [packages/acp-server/README.md](packages/acp-server/README.md)
- Workflow conformance:
  [tests/conformance/acp-workflow/README.md](tests/conformance/acp-workflow/README.md)

## Validation

Run the full repository gate before declaring ACP changes complete:

```bash
ASP_PROJECT=agent-control-plane just verify
```

Focused checks:

```bash
bun run check:public-surface
bun test tests/conformance/acp-workflow
```

`just verify` includes suppression, boundary, manifest, CLI-surface,
public-surface, enablement-changelog, lint, typecheck, and test gates.

## Repository Map

- `AGENTS.md` - agent-facing operating rules for this repository.
- `docs/agent-control-plane-current-spec.md` - current implementation spec.
- `packages/acp-core/` - domain types, presets, legacy kernel, and validators.
- `packages/acp-state-store/` - runtime state, run, queue, and outbox stores.
- `packages/acp-admin-store/` - agents, projects, memberships, and events.
- `packages/acp-interface-store/` - interface bindings and delivery state.
- `packages/acp-conversation/` - conversation thread and turn persistence.
- `packages/acp-jobs-store/` - scheduled jobs, job runs, and flows.
- `packages/acp-server/` - HTTP server, wrkf facades, launch bridge, jobs.
- `packages/acp-cli/` - installed `acp` operator CLI.
- `packages/gateway-discord/` - Discord gateway integration.
- `packages/gateway-ios/` - mobile gateway surface.
- `packages/acp-ops-projection/`, `packages/acp-ops-reducer/`,
  `packages/acp-viewer/` - dashboard projection and viewer surfaces.
- `packages/coordination-substrate/` - coordination ledger.
- `packages/wrkq-lib/` - TypeScript access to wrkq SQLite state.
- `packages/wlearn/` - workflow-learning replay and trace tools.
- `scripts/` - repository checks, discovery tools, and smoke helpers.
- `tests/conformance/acp-workflow/` - canonical ACP workflow conformance suite.
- `launchd/` - launchd source plist for the local ACP server.
- `capabilities/`, `scenarios/`, `specs/` - capability metadata, scenario
  runbooks, and historical or migration specs.
