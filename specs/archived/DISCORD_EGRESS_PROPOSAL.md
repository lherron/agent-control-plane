# Outbound Delivery Attachments — Proposal v2

Status: **v2 — incorporates spec-review feedback from cody (T-01247). Spec changes landing in ../acp-spec under T-01248 in parallel.**

Framing change from v1: this is "register delivery attachments for the current run" — gateway-neutral. Discord is the first consumer; future Slack/Web/etc. gateways inherit the path for free.

## Motivation / current gap

The Discord image-support work (T-01237..T-01241, plus T-01246 fix-up) made ingress fully live: a Discord image arrives, ACP downloads it, codex receives `localImage`, cody describes it. Verified with virtu.

Egress wiring at the gateway is in place (T-01240):

- `packages/gateway-discord/src/discord-render.ts` `renderToDiscord()` extracts `block.t === 'image'`, `block.t === 'tool' && block.images`, and `block.t === 'media_ref'` into Discord file attachments.
- `packages/gateway-discord/src/app.ts` `buildFinalFrame()` converts `delivery.body.attachments` → `media_ref` blocks; `deliverToDiscord()` attaches files to the last chunk.
- Smokey's automated tests cover both render-frame and delivery-attachment paths with synthetic image-bearing frames.

What's missing: an **upstream source** populating `delivery.body.attachments`. Codex's `view_image` is input-only; its image-gen MCP tool writes a file but the runtime sees only text. `interface-response-capture.ts` enqueues deliveries with `bodyText` only — never `attachments`.

## Design (review-approved)

An agent generates an image to any path on disk, then runs a new CLI command that registers the file with the current run. ACP stores it, links it to the run, and consumes it on the next visible-assistant delivery for that run. The gateway already knows how to render `delivery.body.attachments`.

### CLI

```
acp run attachment add <path> [options]
  --run <runId>           Override env-derived run (debug/operator)
  --alt <text>            Caption / alt text (becomes media_ref.alt)
  --filename <name>       Override (default: basename of <path>)
  --content-type <mime>   Override (default: detect from extension)

acp run attachment list                # debug: list current run's pending outbound
acp run attachment clear               # debug: clear pending outbound for current run
```

Naming notes (from review):
- `attachment add` instead of `attach` — `attach` is already overloaded (HRC `attach` and `acp session attach-command` mean terminal/runtime attach).
- `--run` not `--run-id` per CLI.md identifier-flag convention.

### Correlation env

The CLI reads `HRC_RUN_ID` (and validates `HRC_HOST_SESSION_ID` against the run's expected dispatch fence) to identify the current run. These vars are documented in HRC_DETAIL.md / AGENT_SPACES.md by T-01248 (parallel spec PR). If the user prefers `AGENT_RUN_ID` instead, the CLI reads either with `HRC_RUN_ID` taking precedence; the implementation.cli-adapter.ts already sets `HRC_RUN_ID` so no rename is needed unless the spec changes mandate it.

### Endpoint

```
POST /v1/runs/:runId/outbound-attachments
  multipart/form-data
  fields: file (binary), alt? (text), filename? (text), contentType? (text)
  → 201 { outboundAttachmentId, path, filename, contentType, sizeBytes, alt? }

GET  /v1/runs/:runId/outbound-attachments
  → { attachments: OutboundAttachment[] }
```

Key constraints (per cody's review):
- The endpoint **never accepts caller-supplied scope/lane/transport**. It validates `runId`, loads the run record, inherits `SessionRef` from there. The CLI passes only `--run` (or env) and the attachment payload.
- Auth: `runId` plus correlation match. The endpoint requires the caller's correlation env (`HRC_RUN_ID`, `HRC_HOST_SESSION_ID`) to match the run's expected dispatch fence (`expectedHostSessionId`, `expectedGeneration`). CLI override via `--run` is operator/debug mode and requires standard ACP auth (the `acp interface identity register` style).
- Run state gate: only accept while the run is in a state that hasn't yet finalized delivery. Reject on `terminated`/`replaced` etc. Stable error codes (defined by T-01248):
  - `run_not_found`
  - `run_not_accepting_outbound` (state outside the allowed set)
  - `attachment_too_large`
  - `unsupported_content_type`
  - `correlation_mismatch`

### Shared `AttachmentRef` (extended)

Adds one new field for round-trip with `media_ref`:

```ts
interface AttachmentRef {
  kind: 'url' | 'file'
  url?: string
  path?: string
  filename?: string
  contentType?: string
  sizeBytes?: number
  alt?: string  // NEW: caption / alt text. Round-trips with ContentBlock.media_ref.alt.
}
```

The new field is added in `packages/acp-core/src/interface/attachment.ts` and the `spaces-runtime/session` `AttachmentRef`; T-01240's `buildFinalFrame()` is updated to copy `alt` through to the `media_ref` block.

### `delivery.body.attachments` documentation

`DeliveryRequestBody.attachments?: AttachmentRef[]` already exists in `acp-core` but is undocumented per CONVERSATION_SURFACE.md ("attachments deferred unless an implementation explicitly documents them"). T-01248 adds canonical documentation in API.md.

### Consumption rule (per-delivery, with explicit marker)

Per cody's recommendation:

- Attachments are registered against a **run** in a `pending` state.
- When `interface-response-capture.ts` enqueues the next visible-assistant `DeliveryRequest` for that run, it consumes all pending outbound attachments by:
  1. Adding them to `delivery.body.attachments` on the new request.
  2. Marking each as `consumed`, recording `consumedByDeliveryRequestId` and the timestamp.
- Subsequent visible-assistant messages from the same run start from an empty pending set. To attach again, the agent must call `acp run attachment add` again.
- **Run-end edge case**: if the run completes with attachments still `pending` (e.g., codex generated an image but produced no visible-assistant message), v1 logs a warning and either:
  - Drops the pending attachments with a `failed` state (debug-visible), OR
  - Emits one final attachment-only delivery with empty bodyText, if ACP has a reliable run-end hook.
  
  Pick one in implementation; recommend the second if the hook exists, since "I attached an image but the user got nothing" is a confusing UX.

### State machine

```
pending  ──(consumed by delivery)──► consumed
   │
   └─(run terminated, no consuming delivery)──► failed
   
consumed ──(delivery acked)──► delivered
consumed ──(delivery failed/requeued)──► consumed (still tied to that delivery; gateway retry uses same file)
```

State persists for run-retention lifetime; cleanup happens via existing run reaper. This keeps debug parity with inbound (`state/media/attachments/<runId>/` files persist until run reap).

### Storage layout

```
state/media/
├── attachments/<runId>/<filename>   # inbound  (T-01238)
└── outbound/<runId>/<filename>      # outbound (new — implementation-side path; T-01248 records this in IMPLEMENTATION_ACTUALS.md, not as a semantic address)
```

Sanitization, max-byte enforcement, content-type detection all reuse `packages/acp-server/src/attachments.ts` primitives from T-01238.

### Store migration

`acp-interface-store` currently persists `bodyKind` and `bodyText` only — no attachments column. Two options:

**Option A — denormalized on delivery row (preferred for v1):** add `bodyAttachmentsJson TEXT NULL` to the deliveries table. `interface-response-capture.ts` writes the attachment refs as JSON on enqueue.

**Option B — separate outbound_attachments table:** `(outboundAttachmentId, runId, state, consumedByDeliveryRequestId, path, filename, contentType, sizeBytes, alt, createdAt, updatedAt)`. Required if we need state-machine queries (`list pending for run`, `requeue with attachments`, etc.).

Option B is more correct given the state machine. v1 implementation: Option B for outbound table + denormalize the consumed attachments onto the delivery row at enqueue time, so the gateway can read them in one query without joining (and so requeue picks up the same attachments without re-resolving the outbound table).

### Behavior matrix

| Scenario | Result |
|---|---|
| Single `acp run attachment add foo.png` then text reply | Discord message: text + 1 file; outbound row → consumed → delivered |
| Multiple adds then text reply | Discord message: text + N files (Discord cap = 10/message; warn + truncate beyond) |
| `acp run attachment add` with no `HRC_RUN_ID` and no `--run` | Exit 1, error |
| Reply spans multiple chunks | Files attached to last chunk (T-01240 behavior, unchanged) |
| File > max-bytes | Exit 1, file rejected; ACP logs |
| Run completes with pending attachments | Either drop with `failed` + debug log OR emit attachment-only final delivery (decided in implementation) |
| Discord delivery fails / requeues | Same attachments re-attached on retry (denormalized JSON on delivery row) |

## Phasing

| Phase | Owner | Scope |
|---|---|---|
| 1. ACP storage + endpoint + AttachmentRef.alt | larry | New `outbound_attachments` table; `POST/GET /v1/runs/:runId/outbound-attachments`; correlation match (`HRC_RUN_ID` + `HRC_HOST_SESSION_ID` against dispatch fence); reuse T-01238 sanitize/max-byte primitives; add `alt?: string` to AttachmentRef in `packages/acp-core/src/interface/attachment.ts` and `packages/runtime/src/session/types.ts`. |
| 2. CLI `acp run attachment` | cody | New subcommand tree in `acp-cli`. Reads `HRC_RUN_ID` (with `--run` override), POSTs multipart to ACP, prints attachment id. `--alt`, `--filename`, `--content-type` flags. `list`/`clear` debug subcommands. |
| 3. Delivery integration | cody (same session as Phase 2) | Update `interface-response-capture.ts` to dequeue outbound attachments on next visible-assistant delivery, denormalize onto delivery row, mark consumed. Update T-01240's `buildFinalFrame()` to thread `alt` into `media_ref.alt`. Run-end hook handling per the chosen behavior. |
| 4. Codex prompt update | curly | Add the "sending images back" snippet to cody's `AGENTS.md` template (or the materialized system prompt path under `packages/harness-codex/`). |
| 5. Validation | smokey | Unit tests at each layer (resolver, endpoint, CLI, response-capture, gateway end-to-end). Integration test: register attachment → run completes → delivery has attachments → gateway emits Discord file. |
| 6. Live virtu smoke | clod | End-to-end: ask cody to generate an image (via codex MCP image-gen tool) and attach it. Verify Discord channel receives the file. |

Phase 1 is foundational; everything else depends on it. Phases 2 and 3 are sequential same-session for cody (both touch acp-cli + acp-server). Phase 4 is independent and can run parallel with 2/3. Phase 5 needs 1-4 landed. Phase 6 needs 5 green.

## Spec dependencies (T-01248, parallel)

- API.md: endpoint inventory, `DeliveryRequest.body.attachments` documentation, error codes
- CLI.md: `acp run attachment add` command + `--run` flag
- HRC_DETAIL.md / AGENT_SPACES.md: `HRC_RUN_ID` / `HRC_HOST_SESSION_ID` / `HRC_SESSION_REF` correlation env documented (or `AGENT_RUN_ID` rename)
- IMPLEMENTATION_ACTUALS.md: `state/media/outbound/<runId>/` storage convention

Implementation phases consume the spec changes; T-01248 must land before Phase 1 is dispatched.

## Resolved open questions (from v1)

1. **Run scope vs delivery scope**: per-run registry consumed by next visible-assistant delivery, with explicit `consumedByDeliveryRequestId` marker.
2. **Lifetime**: kept until run reap. State field tracks `pending` / `consumed` / `delivered` / `failed`.
3. **Auth**: `runId` plus correlation env match (`HRC_HOST_SESSION_ID` against dispatch fence). `--run` override is operator/debug mode and requires standard ACP auth.
4. **Render-frame parallel path**: deferred to v2.
5. **Multi-gateway future**: kept gateway-neutral. `AttachmentRef` fields are generic. Discord-specific caps (10 files/message, size limits) are gateway-side validation, not core.

## What's not changed from v1

- The fundamental shape ("agent generates file → CLI registers → ACP stores → delivery carries → gateway renders") is intact.
- T-01240's gateway-side egress code is the consumer; no further gateway changes needed beyond threading `alt`.
- v1's behavior matrix is preserved with the consumption rule clarified.
