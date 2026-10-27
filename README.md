# Agent Control Plane

Agent Control Plane (ACP) is where events become turns for Praesidium. It owns
gateway surfaces and HRC injectors, alongside agents, sessions, jobs, and
wrkf-backed task lifecycle facades.

The current implementation source of truth is
[docs/agent-control-plane-current-spec.md](docs/agent-control-plane-current-spec.md).
Agent/operator runtime rules live in [AGENTS.md](AGENTS.md). Use those documents
for detailed operational behavior; this README is only the repo entry point.

## Quick Start

Prerequisites: Bun, Just, the local Praesidium dev stack, and the canonical
Verdaccio registry at `http://mini:4873/` for ASP/HRC workspace dependencies.

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

A Bun workspace: ACP packages under `packages/`, repository checks and discovery
tools under `scripts/`, and the workflow conformance suite under `tests/`.
The [package index](docs/package-index.md) is the single source of truth for
what each package owns.
