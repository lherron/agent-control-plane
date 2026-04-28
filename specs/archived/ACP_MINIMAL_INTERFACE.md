# ACP Minimal Interface

This document defines the minimum ACP interface surface required to support
human <-> agent communication through Discord.

It is intentionally smaller than the full coordination + conversation
architecture described in:

- [`API.md`](./API.md)
- [`COORDINATION_SUBSTRATE.md`](./COORDINATION_SUBSTRATE.md)
- [`CONVERSATION_SURFACE.md`](./CONVERSATION_SURFACE.md)

The goal here is not to standardize the full long-term human conversation
surface. The goal is to define the smallest surface that can:

- accept inbound Discord messages
- deterministically resolve a semantic target
- dispatch work to the correct ACP/HRC session
- capture visible assistant turn responses
- deliver those responses back to Discord

## 0. Implementation status (2026-04-21) — complete

The minimal ACP interface described in this document has landed in the current
`agent-spaces` tree. All parts in the package plan and all acceptance criteria
are implemented and covered by tests.

### Landed packages and surfaces

| Area | Current implementation | Status |
|---|---|---|
| Pure interface models | `packages/acp-core/src/interface/*` exports `InterfaceBinding`, `InterfaceMessageSource`, `DeliveryRequest`, binding resolution, and delivery status helpers. | done |
| Interface persistence | `packages/acp-interface-store` owns the SQLite schema and repos for bindings, inbound message sources, and outbound delivery requests. | done |
| ACP HTTP surface | `packages/acp-server` exposes `POST/GET /v1/interface/bindings`, `POST /v1/interface/messages`, `GET /v1/gateway/{gatewayId}/deliveries/stream`, `POST /v1/gateway/deliveries/{id}/ack`, and `POST /v1/gateway/deliveries/{id}/fail`. | done |
| Interface ingress | `POST /v1/interface/messages` resolves channel/thread bindings, records source metadata, creates `InputAttempt` + `Run`, and dispatches through the existing ACP/HRC launch path. | done |
| Response capture | Completed visible assistant `message_end` events enqueue one `DeliveryRequest` per visible assistant message and suppress non-visible/runtime events. | done |
| Operator CLI | `acp admin interface binding list/set/disable` manages bindings for bootstrap and inspection. | done |
| Discord gateway | `packages/gateway-discord` refreshes ACP bindings, sends Discord inbound messages to ACP interface ingress, polls delivery requests, renders Discord output, and acks/fails delivery results. | done |
| End-to-end coverage | `packages/acp-e2e/test/e2e-interface.test.ts` covers binding setup, thread override, ingress, dispatch, response capture, delivery stream targeting, ack, and fail. | done |

### Acceptance criteria verification

| # | Criterion | Verified by |
|---|---|---|
| 1 | One Discord project channel can be bound to one canonical project-scoped `SessionRef`. | `packages/acp-e2e/test/e2e-interface.test.ts` binding create/list case; ACP server binding tests. |
| 2 | Inbound channel message resolves to the bound semantic target without caller-supplied `scopeRef`. | `POST /v1/interface/messages` e2e dispatch case. |
| 3 | Thread-specific binding overrides parent channel binding. | `thread-specific binding overrides the channel binding during interface ingress` e2e case. |
| 4 | Inbound handling creates `InputAttempt` + `Run` and dispatches the correct session. | `POST /v1/interface/messages with a binding creates an InputAttempt + Run and dispatches once` e2e case. |
| 5 | A completed assistant reply creates one outbound `DeliveryRequest`. | `a completed assistant message enqueues exactly one queued delivery request in interface.db` e2e case. |
| 6 | Discord gateway worker delivers the reply back to the bound channel/thread and acks it. | `packages/gateway-discord/src/tests/app.e2e.test.ts` local Discord-client e2e. |
| 7 | Failed Discord delivery is durably recorded and inspectable. | `POST /v1/gateway/deliveries/{id}/fail transitions the delivery to failed and preserves code + message` e2e case. |

### Intentional implementation notes

- The delivery stream endpoint is implemented as JSON polling with a stable
  cursor, not SSE. This still satisfies the MVP semantics: ACP-owned queued
  work items, stable ordering, and explicit ack/fail transitions.
- The storage package uses flattened `scopeRef`/`laneRef` columns internally,
  while the ACP HTTP/API shape presents the documented nested `sessionRef`.
- The Discord gateway preserves the legacy rendering mechanics where useful,
  but now uses ACP bindings, ACP interface ingress, and ACP-owned delivery
  requests underneath.
- Live Discord credentials were not required for automated validation. The
  gateway e2e uses a fake Discord client against the real ACP handler/store
  stack and verifies ingress, rendering, delivery, and ack behavior locally.

## 1. Scope

This MVP assumes a practical Discord deployment pattern:

- each project usually has one Discord channel
- that channel usually has one active ACP binding
- Discord threads may optionally be bound separately when a task-specific or
  review-specific semantic target is needed

The data model stays transport-generic, but for Discord:

- `conversationRef` maps to the Discord channel id
- `threadRef` maps to the Discord thread id when present

The MVP does **not** require a full ACP-owned conversation transcript store.
Discord itself is the human transcript authority for this cut. ACP only needs
enough interface state for routing, idempotency, audit, and outbound delivery.

## 2. Design rules

1. Semantic target must be resolved from a durable binding, not inferred from
   message text, channel names, or mentions.
2. Transport identity must not become semantic identity.
3. Discord ingress must not require the caller to know a canonical
   `SessionRef` ahead of time.
4. Visible assistant replies must be delivered through an ACP-owned outbound
   delivery queue.
5. Internal coordination records and human-visible delivery are linked, but
   they are not the same thing.

## 3. Semantic target resolution

Semantic target is determined by binding lookup.

Minimal algorithm:

1. Receive inbound interface message with:
   - `gatewayId`
   - `conversationRef`
   - optional `threadRef`
   - `messageRef`
   - author metadata
2. Resolve binding in this order:
   - exact match on `(gatewayId, conversationRef, threadRef)` when `threadRef`
     is present
   - fallback match on `(gatewayId, conversationRef)` when no thread-specific
     binding exists
3. Binding returns the canonical target:
   - `sessionRef = { scopeRef, laneRef }`
   - optional `projectId`
4. ACP uses that `SessionRef` as the semantic target for `InputAttempt`, `Run`,
   wake/dispatch, and reply routing.

This gives deterministic routing while preserving the rule that transport
metadata is not semantic identity.

## 4. Minimal data model

### 4.1 `InterfaceBinding`

```ts
type InterfaceBinding = {
  bindingId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string
  sessionRef: {
    scopeRef: string
    laneRef: string
  }
  projectId?: string
  status: 'active' | 'disabled'
  createdAt: string
  updatedAt: string
}
```

Notes:

- `conversationRef` is transport-native. For Discord MVP it is the channel id.
- `threadRef` is also transport-native. For Discord MVP it is the thread id.
- The expected deployment pattern is one active binding per project channel,
  with optional thread-level overrides for more specific semantic routing.

### 4.2 `InterfaceMessageSource`

```ts
type InterfaceMessageSource = {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string
  messageRef: string
  authorRef: string
  receivedAt: string
}
```

This is the minimum ingress metadata ACP should persist or attach to the
resulting `InputAttempt` / `Run`.

### 4.3 `DeliveryRequest`

```ts
type DeliveryRequest = {
  deliveryRequestId: string
  gatewayId: string
  bindingId: string
  sessionRef: {
    scopeRef: string
    laneRef: string
  }
  runId?: string
  inputAttemptId?: string
  conversationRef: string
  threadRef?: string
  replyToMessageRef?: string
  body: {
    kind: 'text/markdown'
    text: string
  }
  status: 'queued' | 'delivering' | 'delivered' | 'failed'
  createdAt: string
  deliveredAt?: string
  failure?: {
    code: string
    message: string
  }
}
```

This MVP only requires final text/markdown delivery. Attachments, cards,
message edits, and partial-stream frames are explicitly deferred.

## 5. Minimal endpoint surface

### 5.1 `POST /v1/interface/bindings`

Create or replace a binding from transport identity to canonical `SessionRef`.

This is the write path that sets up:

- one binding per Discord project channel
- optional thread-specific overrides

### 5.2 `GET /v1/interface/bindings`

List bindings, primarily for operator inspection and bootstrap verification.

Recommended filters:

- `gatewayId`
- `conversationRef`
- `threadRef`
- `projectId`

### 5.3 `POST /v1/interface/messages`

Accept one inbound human message from an external interface.

Illustrative request:

```json
{
  "idempotencyKey": "discord:message:1234567890",
  "source": {
    "gatewayId": "discord_prod",
    "conversationRef": "channel:1234567890",
    "threadRef": "thread:5555555555",
    "messageRef": "discord:message:1234567890",
    "authorRef": "discord:user:9999999999"
  },
  "content": "Please summarize the status of T-01144."
}
```

Semantics:

- resolve binding using the algorithm in §3
- reject with `404 interface_binding_not_found` when no active binding exists
- create `InputAttempt` and `Run`
- attach resolved source metadata to the run/input attempt
- dispatch through ACP/HRC using the bound `SessionRef`
- remember the ingress message as the default reply anchor for the first
  visible assistant response

This endpoint is the interface-aware ingress path. It exists so the caller
does not need to know ACP semantic addressing.

### 5.4 `GET /v1/gateway/{gatewayId}/deliveries/stream`

Expose queued outbound `DeliveryRequest` work items for the gateway worker.

The wire format may be SSE or another stream/lease shape, but the semantics
must be:

- delivery requests are ACP-owned work items
- each item is targeted to one binding/conversation/thread
- items preserve per-run ordering
- a failed delivery does not silently disappear

### 5.5 `POST /v1/gateway/deliveries/{deliveryRequestId}/ack`

Mark an outbound delivery as successfully delivered.

### 5.6 `POST /v1/gateway/deliveries/{deliveryRequestId}/fail`

Mark an outbound delivery as failed with a machine-readable failure code and a
human-readable message.

## 6. Inbound flow

For Discord MVP:

1. Discord gateway receives a user message in a channel or thread.
2. Gateway maps:
   - channel id -> `conversationRef`
   - thread id -> `threadRef`
3. Gateway posts to `POST /v1/interface/messages`.
4. ACP resolves the binding to canonical `SessionRef`.
5. ACP creates `InputAttempt` + `Run`.
6. ACP dispatches the run through the existing ACP/HRC path.
7. ACP records coordination links as needed, but Discord remains the visible
   human transcript for this MVP.

## 7. Turn responses and Discord egress

### 7.1 What counts as a visible response

For this MVP, only completed assistant-authored visible messages should create
Discord egress work.

That means:

- assistant final text from a completed turn is visible
- tool events are not directly visible
- internal coordination events are not directly visible
- partial token streaming is not directly visible

This keeps the MVP small and avoids requiring transcript-local pending or
streaming state.

### 7.2 Response capture rule

When a run produces a completed assistant message suitable for a human-facing
reply, ACP should materialize one `DeliveryRequest`.

Recommended boundary:

- source outbound human-visible text from the completed assistant message in
  the session event stream, i.e. the assistant `message_end` payload or
  equivalent final assistant-message event
- capture on final assistant message completion, not token deltas
- one completed visible assistant message -> one delivery request
- preserve ordering if a run emits multiple visible assistant messages

This means the Discord reply is a projection of the assistant turn result, not
of a tool call, coordination event, or raw token stream.

### 7.3 Reply targeting

Outbound delivery target comes from the same resolved binding used for ingress.

Rules:

- `conversationRef` and optional `threadRef` come from the binding
- the first outbound reply for a run may set `replyToMessageRef` to the
  inbound `messageRef` when the transport supports native reply anchors
- subsequent outbound messages in the same run may omit `replyToMessageRef`
  and continue in the same channel/thread

For Discord this means:

- responses post back to the bound project channel by default
- if the inbound message was in a bound thread, the response returns to that
  same thread
- the first response may use Discord's native reply-to-message affordance

### 7.4 Gateway worker behavior

The Discord worker consumes outbound `DeliveryRequest` items and performs the
actual transport delivery.

Minimal responsibilities:

1. Read queued delivery work for `gatewayId = discord_prod`.
2. Post the message to the target channel/thread.
3. Use `replyToMessageRef` when present and supported.
4. Ack success back to ACP.
5. Report failure back to ACP with code/message on transport errors.

### 7.5 Failure behavior

If Discord delivery fails:

- ACP retains the failed delivery record
- run/task state is not retroactively erased
- operators can inspect and retry or manually recover

The MVP does not require a full operator UI for retries, only durable failed
state and explicit failure reporting.

## 8. Relationship to the current landed ACP MVP

The landed ACP MVP already provides useful building blocks:

- canonical `SessionRef`
- `POST /v1/runtime/resolve`
- `POST /v1/sessions/resolve`
- `POST /v1/inputs`
- `GET /v1/runs/{runId}`
- `POST /v1/messages` for coordination events
- task/role-scoped `POST /v1/sessions/launch`

But those are not yet sufficient for Discord comms because they do not provide:

- binding lookup from channel/thread to `SessionRef`
- interface-aware ingress
- outbound delivery queueing
- delivery ack/fail tracking

This document defines that missing minimal interface layer.

## 9. Explicit non-goals

This MVP does **not** require:

- a full ACP-owned conversation transcript database
- audience-specific transcript projections
- transcript-local streaming or pending states
- message edits
- rich cards or attachments
- semantic target inference from message text or mentions
- automatic task/thread creation from raw Discord traffic
- making Discord identifiers part of `ScopeRef`

## 10. Monorepo package plan

This interface brief implies concrete monorepo work in `../agent-spaces`.

The goal is to extend ACP with a small interface layer while reusing the proven
Discord mechanics from `../control-plane/packages/gateway-discord`.

### 10.1 Existing packages to extend

#### `packages/acp-core`

Add the pure model and helper layer for interface mechanics:

- `InterfaceBinding`
- `InterfaceMessageSource`
- `DeliveryRequest`
- pure binding-resolution helpers
- pure response-capture helpers where they can be expressed without transport
  dependencies

This package should stay transport-agnostic and side-effect-free.

#### `packages/acp-server`

Add the HTTP/API layer for interface ingress and outbound delivery state:

- `POST /v1/interface/bindings`
- `GET /v1/interface/bindings`
- `POST /v1/interface/messages`
- `GET /v1/gateway/{gatewayId}/deliveries/stream`
- `POST /v1/gateway/deliveries/{deliveryRequestId}/ack`
- `POST /v1/gateway/deliveries/{deliveryRequestId}/fail`

This is also the layer that should:

- resolve bindings to canonical `SessionRef`
- create `InputAttempt` and `Run`
- dispatch through ACP/HRC
- materialize outbound `DeliveryRequest` records from completed assistant turn
  results

#### `packages/acp-e2e`

Add end-to-end coverage for:

- binding lookup
- inbound interface message -> `InputAttempt`/`Run`
- completed assistant turn -> `DeliveryRequest`
- Discord worker ack/fail lifecycle

#### `packages/coordination-substrate`

Do **not** turn this package into a Discord gateway package.

It may carry linkages back to coordination events/handoffs when useful, but the
interface binding store and outbound delivery queue should remain separate
concerns.

### 10.2 New packages to add

#### `packages/acp-interface-store`

Add a dedicated persistence package for interface-facing state.

Minimum responsibilities:

- store `InterfaceBinding` records
- resolve bindings by `(gatewayId, conversationRef, threadRef?)`
- store inbound interface message metadata when needed for idempotency/audit
- store and lease outbound `DeliveryRequest` records
- record delivery success/failure state

This package should own the ACP-side interface SQLite schema rather than
smearing that state across unrelated packages.

#### `packages/gateway-discord`

Add an ACP-side Discord gateway package by reusing and adapting the legacy
implementation from `../control-plane/packages/gateway-discord`.

Minimum responsibilities:

- consume ACP outbound `DeliveryRequest` work
- translate Discord inbound traffic into `POST /v1/interface/messages`
- preserve the proven Discord render/chunk/edit/attachment behavior from the
  legacy gateway
- adapt the existing reducer/render pipeline to ACP/HRC lifecycle session
  events instead of legacy control-plane event-hub traffic

Default stance:

- port or reuse logic from the legacy package first
- replace only the control-plane-specific seams underneath it

### 10.3 Preferred ownership split

Use this ownership boundary unless implementation proves it inadequate:

- `acp-core`
  - pure types and helpers
- `acp-interface-store`
  - bindings and delivery persistence
- `acp-server`
  - API/orchestration
- `gateway-discord`
  - Discord transport integration and rendering

This keeps Discord-specific mechanics out of ACP core packages while still
making ACP authoritative for semantic routing and outbound delivery state.

## 11. Acceptance criteria

The minimal interface should not be considered ready until it can demonstrate:

1. One Discord project channel can be bound to one canonical project-scoped
   `SessionRef`.
2. An inbound message in that channel resolves to the bound semantic target
   without the gateway caller supplying `scopeRef`.
3. A thread-specific binding overrides the parent channel binding when present.
4. Inbound message handling creates `InputAttempt` + `Run` and dispatches the
   correct session.
5. A completed assistant reply creates one outbound `DeliveryRequest`.
6. The Discord gateway worker delivers that reply back to the bound
   channel/thread and acks it.
7. Failed Discord delivery is recorded durably and inspectably.

## 12. Reuse and research baseline

ACP is a replacement for the legacy control-plane application in
`../control-plane`. Discord integration there has already been exercised and
debugged extensively. The ACP implementation should reuse as much of that
Discord-specific behavior as practical rather than inventing a new Discord
render/delivery stack.

For the MVP, treat `../control-plane/packages/gateway-discord` as the source of
truth for Discord mechanics and rendering behavior until ACP proves a justified
divergence.

### 12.1 What should be reused first

The following areas are the preferred reuse targets:

- binding lookup semantics in `src/bindings.ts`
  - exact thread match first, then channel fallback
- event-to-run-state reduction in `src/session-events-manager.ts`
  - especially the logic that derives visible assistant output from session
    events and suppresses non-visible runtime metadata
- `RenderFrame` -> Discord text rendering in `src/render.ts`
  - markdown/code formatting
  - chunk splitting
  - action button custom-id generation
  - attachment placeholder behavior
- Discord send/edit/delete mechanics in `src/app.ts` and `src/discord-render.ts`
  - placeholder message creation and reuse
  - quiet vs verbose binding behavior
  - message edit vs follow-up send rules
  - thread targeting
  - attachment sending
  - Discord-specific error classification

Relevant validation coverage already exists in:

- `../control-plane/tests/integration/gateway-discord-render.test.js`
- `../control-plane/packages/gateway-discord/src/tests/session-events-manager.test.ts`
- `../control-plane/tests/e2e-discord-full.ts`

### 12.2 What ACP should replace underneath it

ACP should replace the legacy control-plane orchestration layer, not the proven
Discord-specific mechanics.

That means ACP should swap in:

- ACP bindings and `SessionRef` targeting instead of legacy project/session
  routing
- ACP/HRC ingress and run creation instead of legacy `gateway.session.input`
- ACP-owned outbound `DeliveryRequest` queueing instead of legacy `cp.send`
  and `cp.delete`

But ACP should preserve the proven Discord-side behavior wherever practical.

### 12.3 Event compatibility direction

The lifecycle/session event messages from HRC plus the canonical session-event
contract in [`../contracts/SESSION_EVENTS.md`](../contracts/SESSION_EVENTS.md)
should be treated as drop-in replacements for the legacy control-plane
event-hub feed consumed by `gateway-discord`.

Practical implication:

- the reducer and render pipeline from `gateway-discord` should be adapted to
  ACP/HRC session events first
- do not redesign Discord rendering around a different event model unless the
  HRC/ACP event contract proves insufficient
- prefer a compatibility shim from ACP/HRC session events into the existing
  reducer expectations over a fresh Discord rendering implementation

### 12.4 Research requirement

Before implementing ACP Discord egress or human-visible turn rendering, the
implementer must inspect `../control-plane/packages/gateway-discord` and its
tests to answer:

1. Which files can be reused directly with minimal adaptation?
2. Which assumptions are legacy control-plane-specific and must be replaced by
   ACP equivalents?
3. Which Discord rendering/debugging behaviors have already been solved there
   and should therefore be preserved?

The default implementation stance is:

- reuse first
- adapt second
- redesign only when there is a concrete ACP/HRC incompatibility
