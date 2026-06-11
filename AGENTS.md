## agent-control-plane

This is the ACP (Agent Control Plane) layer of the three-repo split
(ASP / HRC / ACP). It owns the workflow kernel, task/control-plane state,
the ACP HTTP server, interface gateways (Discord, iOS), and operator
dashboards/viewers.

Current implementation spec: [`docs/agent-control-plane-current-spec.md`](docs/agent-control-plane-current-spec.md).
It reflects the live wrkf-backed task route migration and supersedes older
top-level planning notes for current behavior.

ASP packages (agent-scope, cli-kit, spaces-config, spaces-runtime, etc.) and
HRC packages (agent-action-render, hrc-core, hrc-sdk, hrc-frame-render, etc.)
are external dependencies sourced from the local Verdaccio registry at
`http://127.0.0.1:4873/`.

## Build & Run

```bash
bun install       # Install dependencies (resolves ASP+HRC deps from Verdaccio)
bun run build     # Build all ACP packages in order
```

## Validation

- Conformance: `bun test tests/conformance/acp-workflow`
- Tests: `bun run test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`

## Project Structure

```
packages/
├── acp-core/             # Workflow domain types, kernel, presets, validators
├── acp-state-store/      # SQLite repos for workflow/runtime/input/transition-outbox
├── acp-admin-store/      # SQLite repos for agents, projects, memberships, heartbeats
├── acp-interface-store/  # SQLite repos for interface bindings, message sources
├── acp-conversation/     # SQLite conversation thread/turn store
├── acp-jobs-store/       # SQLite job/cron/flow records
├── acp-server/           # ACP HTTP server: workflow/task/admin/interface/runtime
├── acp-cli/              # `acp` operator/user CLI
├── acp-e2e/              # End-to-end ACP × HRC tests
├── acp-ops-projection/   # Operator dashboard projection contracts
├── acp-ops-reducer/      # Pure client reducer for the ops dashboard
├── acp-viewer/           # Local read-only ACP state viewer web app
├── gateway-discord/      # ACP Discord interface gateway
├── gateway-ios/          # iOS/mobile gateway (currently the HRC mobile surface)
├── coordination-substrate/ # SQLite ledger for handoffs/wake/coordination
├── wrkq-lib/             # TS store layer over wrkq SQLite
└── wlearn/               # Workflow-learning replay/trace tools
```

Conformance tests live in `tests/conformance/acp-workflow/`.

## Repo Boundaries

Enforced by `bun run check:boundaries`:

- ACP source may import ASP and HRC packages by name from Verdaccio.
- ACP source **must not** reach into HRC implementation internals via
  subpath imports like `hrc-server/src/...` or relative path traversals.
- ACP source **must not** reference HRC-only feature identifiers; this is a
  content scan, not just an import scan. HRC-internal enrichment features should
  never become ACP coupling points.

## ACP Server Lifecycle

The `acp` daemon is managed via launchd:

- Plist: `launchd/com.praesidium.acp-server.plist` (canonical source); installed
  to `~/Library/LaunchAgents/com.praesidium.acp-server.plist`.
- HTTP: `http://127.0.0.1:18470`
- State DBs: `/Users/lherron/praesidium/var/db/acp-{state,interface,coordination,admin,...}.db`
- Logs: `/Users/lherron/praesidium/var/logs/acp-server.{log,err.log}`

The binary at `/Users/lherron/.bun/bin/acp` is `bun link`ed from this repo's
`packages/acp-cli`. After local changes:

```bash
bun run build
launchctl kickstart -k gui/$(id -u)/com.praesidium.acp-server
acp server status
```

`ACP_REAL_HRC_LAUNCHER=1` and the embedded `HRC_RUNTIME_DIR`/`HRC_STATE_DIR`
env in the ACP plist tell `acp-server` to spawn real HRC client paths against
the locally-running HRC daemon. These are runtime contracts; do not rename
them as part of repo-ownership tidying.

## Discord Gateway Validation

When changing Discord gateway behavior, smoke test with real Discord. Fake
Discord clients, mocked channel objects, and in-process Discord substitutes
are acceptable for automated tests, but they do not count as manual smoke
validation.

For gateway changes, verify the behavior in an actual Discord channel/thread
using the installed gateway, real bot credentials, and ACP/HRC services.
Report the real Discord smoke result when handing work back. If real Discord
validation is blocked, say exactly what blocked it and do not present
fake-client output as a successful smoke test.

## ACP Discord Bindings

Bindings map a Discord conversation to an ACP session scope. Manage them under
`acp admin interface binding` (note: under `admin interface`, not bare
`interface`).

```bash
acp admin interface binding list --json
acp admin interface binding set --gateway <id> --conversation-ref channel:<discord-channel-id> \
  --project <projectId> --scope-ref <scopeRef> --lane-ref main --json
acp admin interface binding disable --binding <id>
```

Notes:

- `binding set` upserts on `(gatewayId, conversationRef [, threadRef])`. Re-running
  `set` with the same channel keeps the same `bindingId` and updates the
  scope/lane — repointing a channel without churning binding IDs.
- `conversationRef` for a channel is `channel:<id>`; for a thread, add
  `--thread-ref thread:<id>`. Use the numeric Discord ID, not the `#name`.
- Standard dev gateway is `acp-discord-smoke`; bind
  `agent:<agent>:project:<project>:task:<task>` for task-scoped routing.

Verifying a binding:

```bash
CP_CHANNEL_ID=<channel-id> ./scripts/virtu-send.sh "ping"
acp session resolve --scope-ref <scopeRef> --lane-ref main --json
acp session runs --session <sessionId> --json
TOKEN=$(consul kv get cfg/dev/_global/discord/master_token)
curl -sS -H "Authorization: Bot $TOKEN" \
  "https://discord.com/api/v10/channels/<channel-id>/messages?limit=5" \
  | jq -r '.[] | {author: .author.username, ts: .timestamp, content}'
```

The run's `metadata.meta.interfaceSource.bindingId` is the authoritative proof
that a specific binding routed the inbound — match it against the binding you
just created.

## Ops Dashboard

`acp-ops-web` is referenced by older notes, but this checkout does not contain
a tracked `packages/acp-ops-web/package.json`. Use `acp-viewer` for the current
local dashboard surface unless that package is restored.

Notes:

- Real snapshot endpoint: `/v1/ops/session-dashboard/snapshot`.
- A successful real snapshot can contain sessions with `events: 0`; an empty
  event stream is not automatically a rendering bug.
- Dev demo data should only appear when the snapshot request fails in
  development, not before a successful real snapshot replaces it.

## ACP Viewer

Run from `packages/acp-viewer`:

```bash
bun run dev
```

The dev server binds `0.0.0.0:18471` with `strictPort`, proxying `/v1` to the
local ACP server at `127.0.0.1:18470`. Open the relevant
`http://127.0.0.1:18471/...` route.

## Conformance Tests

`tests/conformance/acp-workflow/` is the canonical ACP workflow kernel test
suite. Always run before declaring ACP work done:

```bash
bun test tests/conformance/acp-workflow
```

## Cross-Repo Consumption

`.npmrc` in this repo points `registry=http://127.0.0.1:4873/`. The Verdaccio
upstream policy serves ASP/HRC cross-repo packages from local storage only
(no public-npm fallthrough on those names) and proxies everything else
(`chalk`, `commander`, `@anthropic-ai/*`, ...) to the public npmjs registry.
