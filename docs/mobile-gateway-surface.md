---
id: agent-control-plane/mobile-gateway-surface
title: Mobile and iOS Gateway Surface
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# Mobile and iOS gateway surface

There are **two distinct mobile-facing surfaces** in this repo. They are easy
to conflate because both are described as "the mobile gateway" in
higher-level docs, but they are different code, different ports, and
different maturity levels.

## 1. `/v1/mobile/*` — embedded in acp-server (production surface)

This is the surface a real iOS/mobile client should point at. It is served
directly by `acp-server` on its normal port (`127.0.0.1:18470`), implemented
in `packages/acp-server/src/handlers/mobile.ts` and `mobile-ws.ts` (routed
in `packages/acp-server/src/routing/{exact-routes,param-routes}.ts`) — the
same process and port as every other ACP HTTP route, restarted the same way
(`acp server restart`).

Routes:

| Route | Kind | Purpose |
|---|---|---|
| `GET /v1/mobile/health` | http | Health/capability probe. |
| `GET /v1/mobile/pairing`, `POST /v1/mobile/pair` | http | Device pairing. |
| `GET /v1/mobile/dashboard` | websocket | Session dashboard snapshot + live updates (`dashboard_snapshot` envelope) — this is what gateway-discord itself polls to detect steerable active runs. |
| `GET /v1/mobile/history` | http | Progressive history / timeline paging. |
| `GET /v1/mobile/dm/targets` | http | DM target discovery. |
| `POST /v1/mobile/messages/query`, `POST /v1/mobile/messages/dm` | http | Message query and semantic DM send. |
| `GET /v1/mobile/messages/watch` | http/ws | Message watch stream. |
| `POST /v1/mobile/sessions` | http | Provision a new session — a suffix-roster slot for the quick-pick lanes, or the one exact scope the operator named. The client supplies a stable `requestId` per button press; transport retries reuse it. |
| `POST /v1/mobile/sessions/:hostSessionId/input` | http | Literal input to a session. |
| `POST /v1/mobile/sessions/:hostSessionId/interrupt` | http | Interrupt a session. |
| `GET /v1/mobile/sessions/:hostSessionId/attach-info` | http | Loopback-only attach descriptor for an embedded terminal (HRCMac). |
| `POST /v1/mobile/auth/pairing-code` | http | Loopback-only. Mint the single outstanding pairing code. |
| `GET /v1/mobile/auth/devices` | http | Loopback-only. Paired devices + enforcement posture. |
| `POST /v1/mobile/auth/devices/revoke` | http | Loopback-only. Revoke one device's bearer token. |
| `POST /v1/mobile/auth/enforce` | http | Loopback-only. Arm/disarm bearer enforcement. |

`POST /v1/mobile/sessions` accepts `agentId`, `projectId`, optional `taskId`,
optional `viewerWindow`, and `requestId`. The server derives an HRC idempotency
key from `requestId`, names the
`agent:<agentId>:project:<projectId>:task:<taskId>` scope, and returns the scope
HRC actually claimed. `taskId` is trimmed and defaults to `primary`; it is not
restricted to a server-side allowlist — well-known lanes (`primary`, `minisvc`,
`minilab`, `hrcdev`) and operator-typed task ids alike are accepted as long as
they satisfy the canonical agent-scope token grammar (`[A-Za-z0-9._-]{1,64}`).
Tokens outside that grammar are rejected as `malformed_request` before any HRC
call.

The task token selects the HRC creation policy:

| `taskId` | HRC START shape | Collision behavior |
|---|---|---|
| `primary`, `minisvc`, `minilab` | `{ baseSessionRef, conflictPolicy: "suffix" }` | Walks the roster family (`primary` → `primary-nova` → ...). |
| `hrcdev` and every other valid token | `{ sessionRef, conflictPolicy: "reject" }` | Claims that one scope or refuses it; no next slot, no reuse of a live conversation. |

Both shapes send `summonIntent: "implicit"`, the durable request-derived
`idempotencyKey`, and `restartStyle: "reuse_pty"`, and neither carries a
`hostSessionId` or any destination-node assertion: HRC owns placement and
resolves where the named scope lives from policy and registry state. Both
responses must carry HRC's claim, and the response DTO (`claimedScope`,
`sessionRef`, `hostSessionId`, `runtimeId`, `status`, `replayed`) is projected
from that claim rather than from what ACP asked for.

Reaching HRC is not the same as landing a session. Suffix starts additionally
require every member of the claimed roster family (`<taskId>`, `<taskId>-nova`,
...) to name the local node through an exact `[placement.task-defaults]` entry in
the agent profile, so a quick-pick lane with no such declaration is refused
downstream with `stale_context`, not by ACP. Exact starts are refused with
`session_scope_occupied` when that scope is already open, which ACP maps to HTTP
409 with the stable message `that scope is already open`; the existing
`session_roster_exhausted` / `idempotency_key_conflict` /
`roster_claim_superseded` 409 mappings are unchanged.

`viewerWindow` defaults to `ACP_MOBILE_VIEWER_WINDOW`, or `console` when the
environment variable is unset. The route carries no auth of its own; it sits in
the bearer tier described below like every other non-exempt mobile route.

### Bearer auth (spec: `docs/mobile-surface-bearer-auth-spec.md`)

acp-server binds 127.0.0.1 **and** the tailscale address, so this surface is
loopback-*trusted* but tailnet-*reachable*. Bearer auth closes that gap. The gate
covers every `/v*/mobile/*` path — `/v2/mobile/sessions` and the
`/v2/mobile/dashboard` WS carry the same session data as their `/v1` siblings, and
a future version's routes land in the bearer tier by default.

Three credential classes, decided per request against the socket peer address
(never `X-Forwarded-For`; an unobservable peer is not loopback):

| Route class | Loopback peer | Non-loopback peer |
|---|---|---|
| `GET /v1/mobile/health`, `GET /v1/mobile/pairing` | open | open (needed pre-pairing; leak nothing secret) |
| `POST /v1/mobile/pair` | open — codeless ack, or redeem a code | the **pairing code** is the credential; no/invalid/expired code → 401 |
| every other `/v*/mobile/*` route | no bearer required | `Authorization: Bearer <token>` required, HTTP and WS upgrade alike |

Denials are always `401 {"ok":false,"code":"unauthorized"}` — identical for a
missing and an invalid credential, so a prober learns nothing. attach-info and the
`/v1/mobile/auth/*` admin routes keep their stricter loopback-only gate on top: a
bearer never substitutes for locality.

One decision function (`packages/acp-server/src/mobile-auth/gate.ts`) is called
from both the HTTP router (`create-acp-server.ts`) and the Bun WS upgrade path
(`cli.ts`, before `server.upgrade()`), so the two cannot drift. No handler carries
auth code of its own.

Operator surface — the server is the state file's only writer, so the CLI mutates
`mobile-auth.json` exclusively through the loopback admin routes:

```
acp mobile pairing-code                  # single-use, 5 min TTL, voids any outstanding code
acp mobile devices list
acp mobile devices revoke --device <id>
acp mobile auth status
acp mobile auth enable [--force]         # --force required when no device is paired
acp mobile auth disable                  # emergency rollback
```

Enforcement is off by default (`enforce: false` in
`var/state/acp-server/mobile-auth.json`, overridable with `ACP_MOBILE_AUTH_PATH`).
While it is off nothing is refused — including the codeless tailnet pair the
shipped iOS client sends today — but code redemption still mints tokens, so a
device can be paired before the gate is armed. Tokens are returned exactly once at
pairing; only their SHA-256 is stored, and they never reach any log.

`GET /v1/mobile/sessions/:hostSessionId/attach-info`
(`packages/acp-server/src/handlers/mobile-attach-info.ts`) is the only route on
this surface that *enforces* the loopback convention rather than assuming it. It
exists so HRCMac can fast-attach an embedded libghostty terminal to a session's
durable broker-tmux, and it **proxies** hrc-server's attach descriptor
(`hrcClient.getAttachDescriptor`) — `argv` is hrc-server's verbatim, and
`socketPath`/`target` are read back out of that same argv rather than recomputed,
so exactly one place knows how to build an attach command.

Two fail-closed gates, both answered with `404 {"reason":"not_local"}`:

- the socket peer must be loopback — an *unobservable* peer is not loopback, so a
  listener that does not thread `server.requestIP()` through
  `createAcpServer().handler(request, { peer })` denies rather than assumes local
  (the peer is never read from `X-Forwarded-For`, which a remote caller controls);
- the session must live on the hrc node this gateway is co-resident with, which is
  exactly "the local hrc control socket knows this `hostSessionId`" — `listSessions`
  reads that node's own store and never federated projections.

A local session with nothing to attach to (no durable broker lease, dead runtime,
headless-without-tui) is `409 {"reason":"not_attachable"}`. Both codes are routing
signals, not errors: the app falls back to the frame timeline. Success is
`{ local: true, argv, socketPath, target, bindingFence }`, where `bindingFence`
carries `runtimeId` + `generation` so the client can refuse to attach across a
runtime rotation. Contract: `clients/hrc-ios/HRCMAC_EMBEDDED_TERMINAL_SPEC.md` §3.2.

The probe cannot start anything, which is what makes it safe to call on every
window open. It asks hrc-server for a descriptor by **explicit `runtimeId`**, and
`GET /v1/attach` passes `strictRuntimeId: true` — so a session whose runtime is
not an attachable broker is refused (`runtime_unavailable` → 409 not_attachable)
rather than reprovisioned into one. A client that polls attach-info against a
headless session therefore never conjures a tmux lease as a side effect.

`handlers/mobile.ts` (~2,000 lines) covers federation-node projection types
(`FederationNodeRuntimeProjection`, `FederationPeerHealthObservation`, ...)
imported from `hrc-core`, meaning this surface is federation-aware — it can
represent remote-node session/runtime projections (`remote_runtime_projection`
source kind), not just this node's local sessions. A constant string
(`REMOTE_CONTROL_UNAVAILABLE_MESSAGE`) documents that remote timeline,
history, literal input, and interrupt are **not yet available** in "mobile
federation Phase 1" — only local-session control is live today.

## 2. `packages/gateway-ios` — standalone dev binary (exploratory surface)

`gateway-ios` is a **separate, standalone process** — `bun run packages/gateway-ios/src/main.ts` — that binds its own port
(`ACP_IOS_GATEWAY_HOST`/`ACP_IOS_GATEWAY_PORT`, default
`127.0.0.1:18480`). Lifecycle/live-delivery data comes directly from the HRC
control socket (`HRC_SOCKET_PATH` / `HRC_CONTROL_SOCKET`), while durable room
history comes from wrkq through `@wrkq/client` (`ACP_WRKQ_DB` / `WRKQ_DB`,
with the legacy path variables accepted). During the rooms burn-in window,
history is ledger-first with the frozen HRC message store retained as the
lookback fallback. The process does not go through `acp-server` or ACP's own
HTTP routes. It is not booted by
`acp server start`/`restart`; nothing in `server-runtime.ts` references it.

Route surface (`packages/gateway-ios/src/routes.ts`):

| Route | Kind | Purpose |
|---|---|---|
| `GET /v1/health` | http | Health + HRC capability flags. |
| `GET /v1/sessions`, `POST /v1/sessions/refresh` | http | Session index list/filter (`mode`, `status`, `q`) and force-refresh. |
| `GET /v1/history` | http | Progressive history projection. |
| `POST /v1/input`, `POST /v1/interrupt` | http | Literal input / interrupt, fence-validated. |
| `GET /v1/timeline` | websocket | Timeline snapshot + live frames for a `sessionRef` (optionally pinned to a `hostSessionId`/`generation`; omitted means active/latest for that session lineage only — never all sibling generations). |
| `GET /v1/diagnostics/events` | websocket | Raw HRC lifecycle event stream, filterable by category/eventKind. |

Optional bearer-token enforcement in front of all routes via
`ACP_IOS_GATEWAY_TOKEN`.

### Known state (per `packages/gateway-ios/SMOKE.md`, 2026-04-30)

A full end-to-end smoke against a live HRC server found the module's
`start()` was still a stub that never bound a listener; that was fixed in
the same pass. After the fix, most routes passed smoke (health, session
listing/filtering, diagnostics WS, history paging, input/interrupt
validation, bearer-token enforcement, clean SIGTERM). Open caveats recorded
at that time:

- Session status derivation reports every session as `inactive` regardless
  of real activity (`session-index.ts`).
- The timeline WS snapshot is empty by design — `history.frames` is always
  `[]` until it's wired to the reverse-paged history projector.
- `POST /v1/input` against a non-interactive (headless) session returns
  `code='runtime_unavailable'` instead of the intended
  `code='session_not_interactive'`.
- The diagnostics WS occasionally emits a stray `snapshot` envelope it
  isn't supposed to (cosmetic).

Treat `gateway-ios` as a dev/exploratory harness for the HRC session
surface, not the shipped mobile backend — the shipped surface for an actual
iOS app today is `/v1/mobile/*` on `acp-server` (surface 1 above).

## Which one to use

- Building or debugging the real mobile app integration → `/v1/mobile/*` on
  `:18470` (surface 1).
- Poking at raw HRC session/diagnostics data and ledger-backed collaboration
  history with a lighter standalone surface → `gateway-ios` on `:18480`
  (surface 2), keeping in mind the open caveats above.
