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
| `GET /v1/mobile/jobhunt/triage` | http | Forward to Jobhunt `GET /api/hunt/mobile/triage`. |
| `GET /v1/mobile/jobhunt/leads/:id` | http | Forward to Jobhunt `GET /api/hunt/mobile/leads/:id`. |
| `POST /v1/mobile/jobhunt/leads/:id/decision` | http | Forward to Jobhunt `POST /api/hunt/mobile/leads/:id/decision`. |
| `POST /v1/mobile/jobhunt/leads/:id/ask` | http | Forward to Jobhunt `POST /api/hunt/leads/:id/ask`. |
| `GET /v1/mobile/dashboard` | websocket | Session dashboard snapshot + live updates (`dashboard_snapshot` envelope) — this is what gateway-discord itself polls to detect steerable active runs. |
| `GET /v1/mobile/history` | http | Progressive history / timeline paging. |
| `GET /v1/mobile/dm/targets` | http | DM target discovery. |
| `POST /v1/mobile/messages/query`, `POST /v1/mobile/messages/dm` | http | Collaboration-ledger query and room-envelope send. |
| `GET /v1/mobile/messages/watch` | http/ws | Message watch stream. |
| `POST /v1/mobile/sessions` | http | Provision a new session — a suffix-roster slot for the quick-pick lanes, or the one exact scope the operator named. The client supplies a stable `requestId` per button press; transport retries reuse it. |
| `POST /v1/mobile/sessions/:hostSessionId/input` | http | Literal input to a session. |
| `POST /v1/mobile/sessions/:hostSessionId/interrupt` | http | Interrupt a session. |
| `POST /v1/mobile/sessions/:hostSessionId/restart` | http | End the session's conversation and relaunch the same scope fresh through HRC's semantic restart; after HRC commits, ACP expires input queued for the dropped context. |
| `GET /v1/mobile/sessions/:hostSessionId/timeline`, `.../diagnostics` | websocket | Per-session timeline frames and raw diagnostics; the path's `hostSessionId` is the only routing authority. |
| `GET /v2/mobile/sessions` | http | Paginated session index. |
| `GET /v2/mobile/dashboard` | websocket | Dashboard snapshot over the paginated, federation-aware session index. |
| `/v1/mobile/c2/v2/*` (`snapshot`, `actions`, `actions/:requestId`, `artifacts/:id`) | http | C2 mobile cards host (`packages/acp-server/src/c2/`). The v1 C2 paths (`/v1/mobile/c2/cards`, `actions`, `artifacts`) answer `410 wire_version_unsupported`. |
| `GET /v1/mobile/sessions/:hostSessionId/attach-info` | http | Loopback-only attach descriptor for an embedded terminal (HRCMac). |
| `POST /v1/mobile/auth/pairing-code` | http | Loopback-only. Mint the single outstanding pairing code. |
| `GET /v1/mobile/auth/devices` | http | Loopback-only. Paired devices + enforcement posture. |
| `POST /v1/mobile/auth/devices/revoke` | http | Loopback-only. Revoke one device's bearer token. |
| `POST /v1/mobile/auth/enforce` | http | Loopback-only. Arm/disarm bearer enforcement. |

Jobhunt routes use the **strict** mobile auth class: a loopback socket peer or a
valid paired bearer is required even when global enforcement is off. The
forwarder (`handlers/mobile-jobhunt.ts`) supplies `X-Principal: user:lance` and
copies no phone headers. `ACP_JOBHUNT_URL` defaults to
`http://127.0.0.1:18455`; a non-loopback host disables forwarding with 503
`gateway_jobhunt_unavailable` and a logged reason. Lead IDs match
`^[A-Za-z0-9_.:-]{1,128}$`; POSTs accept only JSON objects up to 64 KiB.
Queries, body bytes, upstream status and JSON response bytes pass through
unchanged, with `Cache-Control: no-store`. There is one attempt, no redirect
following, and a complete-response deadline of 10 s for GET, 30 s for POST.
Refused connections return 503 `gateway_jobhunt_unavailable` (POST:
`details.submitted: false`). Other transport failures return 504
`gateway_jobhunt_timeout` for GET or `gateway_jobhunt_uncertain` for POST
(`details.submitted: "unknown"`). Non-JSON upstream responses return 502
`gateway_jobhunt_bad_response` for GET or `gateway_jobhunt_uncertain` for POST
(with `details.submitted: "unknown"` and `details.status`). The phone must read
the lead again after an uncertain write. These errors use
`{error: {code, message, details}}`. Jobhunt owns lead semantics and fences.

### Mobile session creation

`POST /v1/mobile/sessions` accepts `agentId`, `projectId`, `requestId`, and
optional `taskId`, `viewerWindow`, `model`, `force`, `scopeConfirmation`, and
`initialPrompt`. The server derives an HRC idempotency
key from `requestId`, names the
`agent:<agentId>:project:<projectId>:task:<taskId>` scope, and returns the scope
HRC actually claimed. `taskId` is trimmed and defaults to `primary`; it is not
restricted to a server-side allowlist — well-known lanes (`primary`, `minisvc`,
`hrcdev`) and operator-typed task ids alike are accepted as long as
they satisfy the canonical agent-scope token grammar (`[A-Za-z0-9._-]{1,64}`).
Tokens outside that grammar are rejected as `malformed_request` before any HRC
call.

The task token selects the HRC creation policy:

| `taskId` | HRC START shape | Collision behavior |
|---|---|---|
| `primary`, `minisvc` | `{ baseSessionRef, conflictPolicy: "suffix" }` | Walks the roster family (`primary` → `primary-nova` → ...). |
| `primary`, `minisvc` with `scopeConfirmation.mode: "require"` | `{ baseSessionRef, conflictPolicy: "confirm" }` | Requires confirmation before claiming an alternate slot. |
| `hrcdev` and every other valid token | `{ sessionRef, conflictPolicy: "reject" }` | Claims that one scope or refuses it; no next slot, no reuse of a live conversation. |

Both shapes send `summonIntent: "implicit"`, the durable request-derived
`idempotencyKey`, and `restartStyle: "reuse_pty"`, and neither carries a
`hostSessionId` or any destination-node assertion: HRC owns placement and
resolves where the named scope lives from policy and registry state. Both
responses must carry HRC's claim, and the response DTO (`claimedScope`,
`sessionRef`, `hostSessionId`, `runtimeId`, `status`, `replayed`) is projected
from that claim rather than from what ACP asked for.

`initialPrompt` is an optional string. ACP trims it and treats an empty value
as absent. A trimmed string over 16 KiB of UTF-8 returns HTTP 400
`malformed_request` with `details.field: "initialPrompt"`. On claim paths,
HRC binds the trimmed prompt to the start idempotency key. When starting a
fresh runtime, HRC appends the prompt to priming and delivers both in one
first turn. A self-brokered claim or a start response without prompt delivery
evidence can still use ACP's steer as `agent:lance`, provided the start is
unreplayed and ACP finds the matching runtime created at or after request
arrival. Force restart and successor launch use their existing start doors
and follow the same guarded steer path.

When the request includes a nonempty prompt, a successful session response
includes `initialPrompt: { delivered: true, runId, submissionId }` when HRC
carries the prompt at birth, `initialPrompt: { delivered: true, idempotencyKey }`
after HRC admits a fallback steer, or `initialPrompt: { delivered: false, reason }`
if delivery fails or ACP skips it. `runtime_reused` means HRC reused a runtime
and ACP skips delivery. For the fallback, `runtime_not_fresh` covers replays, unavailable
runtime evidence and a force restart whose launch failed. Other reasons are
HRC's error code or submission refusal reason, HRC's `expired` or `cancelled`
disposition when it supplies no reason, or `steer_failed` for an untyped
failure. A request without a nonempty prompt omits the response field.

Reaching HRC is not the same as landing a session. Suffix starts additionally
require every member of the claimed roster family (`<taskId>`, `<taskId>-nova`,
...) to name the local node through an exact `[placement.task-defaults]` entry in
the agent profile, so a quick-pick lane with no such declaration is refused
downstream with `stale_context`, not by ACP. Exact starts are refused with
`session_scope_occupied` when that scope is already open, which ACP maps to HTTP
409 with the stable message `that scope is already open`; the existing
`session_roster_exhausted` / `idempotency_key_conflict` /
`roster_claim_superseded` 409 mappings are unchanged.

`viewerWindow` has no ACP default: when the client omits it, HRC derives the
presentation from the scope shape; a supplied value is forwarded as
`presentation.viewerWindow`. `model` is passed to declaration resolution as the
provision model. `force` (`{ mode: "new_context" | "reconcile" |
"launch_successor" }`, primary scope only, never with `model`) is the "Force new
session" path in `handlers/mobile-force-primary.ts`: ACP resolves the exact
`primary` scope through HRC and either force-restarts its context or
exact-claims an absent scope, without walking the suffix roster. The route
carries no auth of its own; it sits in the bearer tier described below like
every other non-exempt mobile route.

Before any HRC claim or start request, the route obtains the runtime-intent
`harness` and `execution` from HRC declaration resolution
(`HrcClient.resolveRuntimeIntent`) at ACP's resolved placement with ACP's agent
sources; base scope, placement, bundle, correlation, request identity, conflict
policy and viewer choice stay ACP's own, and there is no in-process declaration
interpretation and no fallback. A declaration-resolution rejection sends no
claim or start request and is the one bounded exception to the flat error law:
it is returned in the nested ACP error envelope at the HRC domain status with
the HRC code and detail unchanged plus `stage: "declaration"`,
`attemptState: "not_claimed"` and the `requestId` (`runtime_unavailable` 503,
`declaration_invalid` 422, `unsupported_capability` 422, `malformed_request`
400 with detail code `configured_context_mismatch`).

### Bearer auth

ACP listens on loopback and the tailnet address. The
[mobile bearer auth contract](mobile-surface-bearer-auth-spec.md) defines
the socket-peer trust boundary, pairing and revocation, and the strict
Jobhunt and mobile API relay paths. Read the live enforcement setting with
`acp mobile auth status`.

`GET /v1/mobile/sessions/:hostSessionId/attach-info`
(`packages/acp-server/src/handlers/mobile-attach-info.ts`) requires a loopback
peer. It lets a local embedded-terminal client fast-attach to a session's durable
broker-tmux (it was built for HRCMac, which hrc-ios decommissioned on
2026-10-28), and it **proxies** hrc-server's attach descriptor
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
runtime rotation.

The probe cannot start anything, which is what makes it safe to call on every
window open. It asks hrc-server for a descriptor by **explicit `runtimeId`**, and
`GET /v1/attach` passes `strictRuntimeId: true` — so a session whose runtime is
not an attachable broker is refused (`runtime_unavailable` → 409 not_attachable)
rather than reprovisioned into one. A client that polls attach-info against a
headless session therefore never conjures a tmux lease as a side effect.

`handlers/mobile.ts` covers federation-node projection types
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
`127.0.0.1:18480`). All of its data comes from the HRC control socket
(`HRC_SOCKET_PATH` / `HRC_CONTROL_SOCKET`). The process does not go through
`acp-server` or ACP's own HTTP routes. It is not booted by
`acp server start`/`restart`; nothing in `server-runtime.ts` references it.

Route surface (`packages/gateway-ios/src/routes.ts`):

| Route | Kind | Purpose |
|---|---|---|
| `GET /v1/health` | http | Health + HRC capability flags. |
| `GET /v1/sessions`, `POST /v1/sessions/refresh` | http | Session index list/filter (`mode`, `status`, `q`) and force-refresh; status is derived from the runtime as `active`, `stale` or `inactive`. |
| `POST /v1/input`, `POST /v1/interrupt` | http | Literal input / interrupt, fence-validated; input to a non-interactive session is `400 session_not_interactive`. |
| `GET /v1/diagnostics/events` | websocket | Raw HRC lifecycle event stream for a `sessionRef`, filterable by category/eventKind. |
| `GET /v1/history`, `GET /v1/timeline` | retired | `410 timeline_moved`: history and timeline authority moved to the ACP `/v1/mobile/history` and `/v1/mobile/sessions/:hostSessionId/timeline` routes. |

Optional bearer-token enforcement in front of all routes via
`ACP_IOS_GATEWAY_TOKEN`. `tests/fixtures/mobile/gateway-ios-smoke.md` records
the 2026-04-30 live smoke of this binary.

Treat `gateway-ios` as a dev/exploratory harness for the HRC session
surface, not the shipped mobile backend — the shipped surface for an actual
iOS app today is `/v1/mobile/*` on `acp-server` (surface 1 above).

## Which one to use

- Building or debugging the real mobile app integration → `/v1/mobile/*` on
  `:18470` (surface 1).
- Poking at raw HRC session index and diagnostics data with a lighter
  standalone surface → `gateway-ios` on `:18480` (surface 2).
