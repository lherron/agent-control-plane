## agent-control-plane

The ACP (Agent Control Plane) layer of the three-repo split (ASP / HRC / ACP).
It owns the workflow kernel, task/control-plane state, the ACP HTTP server,
interface gateways (Discord, iOS), and operator dashboards/viewers.

Current implementation spec: [`docs/agent-control-plane-current-spec.md`](docs/agent-control-plane-current-spec.md) —
it supersedes older top-level planning notes for current behavior.

ASP and HRC packages are external dependencies sourced from the canonical
Verdaccio registry at `http://mini:4873/` — the fleet's sole writable registry
store. Exact immutable versions referenced by `bun.lock` must exist there before
installation; `.npmrc` serves ASP/HRC names from local storage only and proxies
everything else to public npm. `just pull-deps` advances published pins and
commits `bun.lock`.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple; fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

- Conformance suite (canonical workflow-kernel tests, run before declaring ACP work done): `bun test tests/conformance/acp-workflow`
- Mobile timeline acceptance gate (opt-in, P-00454/T-07724): `bun run test:acceptance` — spawns an
  isolated real HRC daemon, an isolated real wrkq store and the production `acp-server`, drives
  `/v1/mobile/history` and the timeline WebSocket over real HTTP with bearer auth, and writes
  `var/e2e-reports/mobile-timeline-ordering.json`. Needs `wrkf`/`wrkqadm` on PATH and a non-loopback
  IPv4 interface. It is out of the default `bun run test` gate while it reports an open campaign
  defect; promoting it belongs to the campaign.
- Full repository gate: `ASP_PROJECT=agent-control-plane just verify` — the env var prevents ambient project context from selecting another repository during cross-repo validation.
- Live discovery: `bun scripts/discover-acp.ts <area>` (areas: `routes`, `packages`, `cli`, `adoption`, `all`; `--json` available) computes current route/package/handler/command facts from the tree — prefer it over static prose.
- Enablement lessons route through the [Agent enablement changelog](docs/agent-enablement-changelog.md).

## Repo Boundaries

Enforced by `bun run check:boundaries`:

- ACP may import ASP and HRC packages by name from Verdaccio, but **must not** reach into HRC internals via subpath imports (`hrc-server/src/...`) or relative traversals.
- ACP source **must not** reference HRC-only feature identifiers — this is a **content scan, not just an import scan**. HRC-internal enrichment features must never become ACP coupling points.
- Remote interface ingress may be forwarded through HRC, but HRC remains the placement and native-message authority. ACP must not derive logical node identity or create a second placement registry.

## Scheduled Jobs & Flows

Cron/automation jobs run on the ACP job engine (`acp-jobs-store` +
`acp-server/jobs`). Recurring automations are authored as
`var/agents/<agent>/schedules/*.toml`, compiled with `asp resources plan`, and
applied with `acp admin managed-resource apply`. How to author, register, and
validate a job: [`docs/ACP_JOBS_TASKS_USAGE.md`](docs/ACP_JOBS_TASKS_USAGE.md).

## ACP Server Lifecycle

The `acp` daemon is managed via launchd:

- Plist: `launchd/com.praesidium.acp-server.plist` (canonical source); installed to `~/Library/LaunchAgents/`.
- HTTP: `http://127.0.0.1:18470`
- State DBs: `/Users/lherron/praesidium/var/db/acp-{state,interface,coordination,admin,...}.db`
- Logs: `/Users/lherron/praesidium/var/logs/acp-server.{log,err.log}`

`just install` rebuilds, publishes the ACP set, and updates the main-checkout
links; it does not reload launchd. After runtime changes: `just install`,
`acp server restart`, `acp server status`.

`ACP_REAL_HRC_LAUNCHER=1` and the embedded `HRC_RUNTIME_DIR`/`HRC_STATE_DIR`
env in the ACP plist tell `acp-server` to spawn real HRC client paths against
the locally-running HRC daemon. **These are runtime contracts; do not rename
them as part of repo-ownership tidying.**

## Discord Gateway Validation

When changing Discord gateway behavior, smoke test with real Discord. Fake
clients and mocked channel objects are acceptable for automated tests but do
not count as manual smoke validation — verify in an actual channel/thread using
the installed gateway, real bot credentials, and live ACP/HRC services, and
report that result. If real Discord validation is blocked, say exactly what
blocked it; never present fake-client output as a successful smoke.

## Lifecycle Events → Discord Cards

ACP lifecycle telemetry (`job.dispatched` / `job.completed`, …) is appended to
the **system-events** store (`/v1/admin/system-events`) — an immutable observer
projection, **not authority** — and rendered as embed cards by gateway-discord,
polling globally on a monotonic `afterEventId` cursor (**never** via interface
bindings). Channel: env `ACP_DISCORD_JOB_RUNS_CHANNEL_ID` → Consul
`cfg/dev/_global/discord/job_runs_channel_id`; unset disables it. Full design +
how to add a new event card: [`docs/discord-event-architecture.md`](docs/discord-event-architecture.md).

## Discord Bindings

Bindings map a Discord conversation to an ACP session scope. Facts that bite:

- The CLI surface is `acp admin interface binding ...` — under `admin interface`, not bare `interface`.
- `binding set` upserts on `(gatewayId, conversationRef [, threadRef])`, so re-running with the same channel repoints scope/lane without churning binding IDs.
- `conversationRef` is `channel:<numeric-id>` (thread: add `--thread-ref thread:<id>`) — the numeric Discord ID, never the `#name`.
- A run's `metadata.meta.interfaceSource.bindingId` is the authoritative proof of which binding routed an inbound.

Command walkthroughs and the verification recipe live in
[`docs/gateway-discord-message-flow.md`](docs/gateway-discord-message-flow.md);
the standard dev gateway is `acp-discord-smoke`.

## ACP Viewer

`packages/acp-viewer` is the local read-only dashboard (`bun run dev`, port
`18471` with `strictPort`, proxying `/v1` to `127.0.0.1:18470`). A successful
snapshot can contain sessions with `events: 0` — an empty event stream is not
automatically a rendering bug; dev demo data should only appear when the
snapshot request fails.
