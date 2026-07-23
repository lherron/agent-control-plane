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
| `POST /v1/mobile/sessions/:hostSessionId/input` | http | Literal input to a session. |
| `POST /v1/mobile/sessions/:hostSessionId/interrupt` | http | Interrupt a session. |

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
`127.0.0.1:18480`) and talks **directly to the HRC control socket**
(`HRC_SOCKET_PATH` / `HRC_CONTROL_SOCKET`) via `HrcClient` — it does not go
through `acp-server` or ACP's own HTTP routes at all. It is not booted by
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
- Poking at raw HRC session/timeline/diagnostics data with a lighter,
  directly-HRC-backed surface → `gateway-ios` standalone on `:18480`
  (surface 2), keeping in mind the open caveats above.
