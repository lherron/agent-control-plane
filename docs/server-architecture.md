---
id: agent-control-plane/server-architecture
title: ACP Server Architecture
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# ACP server architecture

`acp-server` (`packages/acp-server`) is the local control-plane HTTP process.
It exposes the `/v1/*` route surface, brokers HRC launch/session resolution,
delegates task/workflow authority to wrkf/wrkq, and hosts the Discord and
mobile interface surfaces in-process. It is launchd-managed as
`com.praesidium.acp-server`, listening on `http://127.0.0.1:18470` by default
(`ACP_HOST`/`ACP_PORT`).

## What acp-server owns vs. delegates

ACP is **not** the task store and **not** the workflow engine. It owns the
HTTP/CLI facade, HRC launch correlation, and its own local SQLite
projections; it is a client of wrkf/wrkq for everything task/workflow, and a
client of hrc-runtime for everything session/runtime.

- **Owns**: the `/v1/*` route surface and `acp` CLI contract; ACP run
  records, dispatch fences, host-session/generation binding, and outbound
  message/attachment records; input admission leases and queue state;
  interface bindings/identities/message sources/delivery records; agents,
  projects, memberships, system-events; conversation threads/turns;
  jobs/job-runs/cron/flow; coordination messages.
- **Delegates**: task/container/comment truth to **wrkq** and transition
  legality/obligations/effects to **wrkf**, both reached through a single
  shared `@wrkq/client` process (`client.wrkq.*` / `client.wrkf.*`). Session
  lifecycle, PTY/runtime provisioning, and the canonical event stream belong
  to **hrc-runtime**; ACP is a client of the HRC SDK/socket and reads the
  HRC SQLite DB read-only for run status.
- The retained `acp-core` in-memory workflow kernel (presets, conformance
  tests, `wlearn` replay) is transitional and is **not** authority for live
  server task routes — see
  `docs/agent-control-plane-current-spec.md` in the repo.

Enforced by `bun run check:boundaries`: ACP source may import ASP/HRC
packages by name from the local Verdaccio registry, but must not subpath-import
HRC internals or reference HRC-only feature identifiers.

## Route surface (selected families)

Route tables live in `packages/acp-server/src/routing/{exact-routes,param-routes,mutating-routes}.ts`.

| Family | Detail |
|---|---|
| `/v1/admin/*` | Agents, projects, memberships, jobs, system-events, interface-identities, contributions/reconcile, managed-resources, agent profile/system-prompt, heartbeats. |
| `/v1/sessions*`, `/v1/runtime/resolve`, `/v1/runs/:runId*` | Session resolve/list/get/events/capture/interrupt/attach-command/reset/launch; runtime placement resolve; run show/cancel/outbound-messages/outbound-attachments. |
| `/v1/inputs`, `/v1/interface/{messages,bindings}` | Input admission and interface message ingest / binding CRUD. |
| `/v1/tasks/:taskId*` | Thin wrkf facades: `GET` returns `{ source: "wrkf", task, instance, next, timeline, evidence, obligations, effects, runs }`; `POST .../transitions`, `.../evidence`, `.../obligations/:id/{waive,cancel}` delegate to wrkf. |
| `/v1/workflow-participant-runs*`, `/v1/wrkf/*` | Participant run start/complete/fail via wrkf `run.*`; `/v1/wrkf/ping` returns `{"wrkf":"available"\|"unavailable"}`. |
| `/v1/webhooks/events`, `/v1/webhooks/wrkq` | Loopback-trusted event webhook ingest: canonical `AcpWebhookEvent` v1, plus a wrkq-v2 compatibility adapter. |
| `/v1/gateway/deliveries*`, `/v1/gateway/:gatewayId/deliveries/stream` | Gateway delivery queue (list/ack/fail/requeue) and an SSE delivery stream — this is how gateway-discord drains outbound work. |
| `/v1/session-refs/events`, `/v1/sessions/:id/events` | SSE session/session-ref event streams, consumed by gateway-discord's live-progress subscriptions. |
| `/v1/mobile/*` | Production HRC mobile surface (see [mobile and iOS gateway surface](/docs/agent-control-plane/mobile-gateway-surface)) — served directly by `acp-server`'s own handlers, not by the standalone `gateway-ios` package. |
| `/v1/admin/system-events` | Immutable observer projection of lifecycle telemetry, rendered as Discord cards by gateway-discord. |

Workflow authority note: ACP-authoritative task-creation, workflow-publish,
supervisor-run, action, patch-proposal, and context-compilation routes were
removed in the "W6a" phase of the canonical workflow refactor. The remaining
`/v1/tasks/:taskId` family are read/delegate facades over wrkf, not a second
source of truth.

## How gateways live inside acp-server

Both interface gateways are **embedded in the `acp-server` process**, not
separate daemons, and both restart via `acp server restart`:

- **gateway-discord** (`packages/gateway-discord`) is booted in-process from
  `packages/acp-cli/src/server-runtime.ts`. It talks to `acp-server` as an
  ordinary HTTP client of its own `/v1/*` surface — `/v1/interface/messages`
  to ingest inbound Discord messages, `/v1/interface/bindings` to resolve
  channel routing, `/v1/gateway/deliveries/:id/{ack,fail}` to drain outbound
  work, `/v1/admin/system-events` to poll lifecycle cards, and
  `/v1/session-refs/events` (SSE) for live per-run progress edits. See
  [gateway-discord message flow](/docs/agent-control-plane/gateway-discord-message-flow).
- **The mobile surface** (`/v1/mobile/*`) is implemented directly inside
  `acp-server` (`packages/acp-server/src/handlers/{mobile,mobile-ws}.ts`),
  distinct from the standalone `packages/gateway-ios` dev binary. See
  [mobile and iOS gateway surface](/docs/agent-control-plane/mobile-gateway-surface)
  for the split between the two.

## HRC launch bridge

`packages/acp-server/src/real-launcher.ts` and `launch-role-scoped.ts`
resolve/provision a host session via the HRC SDK (`HrcClient` over
`discoverSocket()`, env `HRC_RUNTIME_DIR`), dispatch turns, and correlate HRC
run state back onto ACP run records. `ACP_REAL_HRC_LAUNCHER=1` plus the
embedded `HRC_RUNTIME_DIR`/`HRC_STATE_DIR` env in the ACP launchd plist tell
`acp-server` to spawn real HRC client paths against the locally running HRC
daemon — these are runtime contracts and must not be renamed casually.

## State stores

Each domain gets its own SQLite database, opened by a dedicated store
package: `acp-state-store` (runtime/run/input-admission/transition-outbox),
`acp-admin-store` (agents/projects/memberships/system-events),
`acp-interface-store` (interface bindings/message sources/deliveries),
`acp-conversation` (threads/turns), `acp-jobs-store` (jobs/job-runs/cron/flow),
`coordination-substrate` (handoffs/wake/coordination messages). Default paths
live under `/Users/lherron/praesidium/var/db/acp-{state,admin,interface,coordination,jobs,conversation}.db`,
each overridable by an `ACP_*_DB_PATH` env var (see
`packages/acp-server/README.md`).

## wrkf/wrkq bridge

`packages/acp-server/src/wrkf/{client-lifecycle,port,participant-launch,errors}.ts`
hold the one shared `@wrkq/client` process instance that backs both
`client.wrkf.*` (task.inspect/syncMeta, transition.apply, evidence.*,
obligation.*, effect.*, run.*, action.*, workflow.*) and `client.wrkq.*`
(task.{create,show,update} with etag CAS, workflow.timeline, container.show)
calls. The locator precedence for the wrkq database is `--wrkq-db`,
`--wrkq-db-path`, `ACP_WRKQ_DB`, `WRKQ_DB`, `ACP_WRKQ_DB_PATH`, then
`WRKQ_DB_PATH`. `ACP_WRKF_DISABLED=1`/`true` bypasses wrkf startup for local
dev/test; check live availability with `curl http://127.0.0.1:18470/v1/wrkf/ping`.
