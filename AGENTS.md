## agent-control-plane

The ACP (Agent Control Plane) layer of the three-repo split (ASP / HRC / ACP).
It is where events become turns: ACP owns interface gateways (Discord, iOS),
HRC injectors, the workflow kernel, task/control-plane state, the ACP HTTP
server, and operator dashboards/viewers.

Current implementation spec: [`docs/agent-control-plane-current-spec.md`](docs/agent-control-plane-current-spec.md) —
it supersedes older top-level planning notes for current behavior. Use the [documentation index](docs/README.md) for reference and runbook pages.

ASP and HRC packages are external dependencies sourced from the canonical
Verdaccio registry at `http://mini:4873/` — the fleet's sole writable registry
store. Exact immutable versions referenced by `bun.lock` must exist there before
installation; `.npmrc` serves ASP/HRC names from local storage only and proxies
everything else to public npm. `just pull-deps` advances published pins and
commits `bun.lock`.

## Packages

Every package lives in this checkout under `packages/`; the
[package index](docs/package-index.md) gives each one's responsibility. The
`hrc-*` packages here are HRC-facing clients and presentation — search this
repo first for their implementation; HRC runtime authority remains in
`hrc-runtime`. `bun scripts/discover-acp.ts packages --json` computes the live
inventory.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple; fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

- Conformance suite (canonical workflow-kernel tests, run before declaring ACP work done): `bun test tests/conformance/acp-workflow`
- Full repository gate: `ASP_PROJECT=agent-control-plane just verify` — the env var prevents ambient project context from selecting another repository during cross-repo validation.
- Live discovery: `bun scripts/discover-acp.ts <area>` (areas: `routes`, `packages`, `cli`, `adoption`, `all`; `--json` available) computes current route/package/handler/command facts from the tree — prefer it over static prose.
- Focused checks, git hooks and the opt-in mobile timeline acceptance gate: [operations runbook](docs/operations-runbook.md).
- Enablement lessons route through the [Agent enablement changelog](docs/agent-enablement-changelog.md).

## Repo Boundaries

Enforced by `bun run check:boundaries`:

- ACP may import ASP and HRC packages by name from Verdaccio, but **must not** reach into HRC internals via subpath imports (`hrc-server/src/...`) or relative traversals.
- ACP source **must not** reference HRC-only feature identifiers — this is a **content scan, not just an import scan**. HRC-internal enrichment features must never become ACP coupling points.
- Remote interface ingress may be forwarded through HRC, but HRC remains the placement and native-message authority. ACP must not derive logical node identity or create a second placement registry.

## ACP Server Lifecycle

The `acp` daemon runs under launchd from `launchd/com.praesidium.acp-server.plist`
on `http://127.0.0.1:18470`. `just install` rebuilds, publishes the ACP set, and
updates the main-checkout links; it does not reload launchd. After runtime
changes: `just install`, `acp server restart` (Mable primary only; anyone else
asks `mable@<project>:primary`), `acp server status`. The Discord gateway is
embedded, so that restart activates gateway changes too.

`ACP_REAL_HRC_LAUNCHER`, `HRC_RUNTIME_DIR`, `HRC_STATE_DIR` and the other env in
the ACP plist are **runtime contracts; do not rename them as part of
repo-ownership tidying.**

State DB, log, config/secret and viewer details live in the
[operations runbook](docs/operations-runbook.md). Scheduled jobs are authored
as `var/agents/<agent>/schedules/*.toml` and applied through ACP managed
resources: [jobs usage guide](docs/ACP_JOBS_TASKS_USAGE.md).

## Discord Gateway Validation

When changing Discord gateway behavior, smoke test with real Discord. Fake
clients and mocked channel objects are acceptable for automated tests but do
not count as manual smoke validation — verify in an actual channel/thread using
the installed gateway, real bot credentials, and live ACP/HRC services, and
report that result. If real Discord validation is blocked, say exactly what
blocked it; never present fake-client output as a successful smoke.

Bindings, the virtu smoke recipe, and the standard dev gateway
(`acp-discord-smoke`) are in
[gateway-discord message flow](docs/gateway-discord-message-flow.md).
Lifecycle event cards are observer projections, never authority:
[Discord event architecture](docs/discord-event-architecture.md).
