# Discord Image Support Plan

## Goal

Add image support to `packages/gateway-discord` for both directions:

- Image in: a Discord user can send images to a bound channel or thread, and the target agent receives those images as runtime attachments.
- Image out: an agent/tool can return image blocks or media references, and the Discord gateway sends them as Discord file attachments instead of text-only placeholders.

This plan is split into phases tracked by wrkq tasks.

## Phase Tasks

| Phase | Task | Scope |
| --- | --- | --- |
| 1 | `T-01237` | Media contract across ACP/interface/runtime |
| 2 | `T-01238` | ACP-side media materialization |
| 3 | `T-01239` | Discord inbound attachment mapping |
| 4 | `T-01240` | Discord outbound attachment rendering |
| 5 | `T-01241` | Unit, integration, and e2e validation |

Use `wrkq cat <task-id>` for the task details.

## Current Findings

Agent-spaces already has partial outbound support:

- `packages/runtime/src/session/types.ts` supports `ContentBlock` variants for `image` and `media_ref`.
- `packages/gateway-discord/src/render.ts` can extract inline base64 images and media refs from render frames.
- `packages/gateway-discord/src/attachments.ts` can convert extracted images/media refs into `discord.js` `AttachmentBuilder` instances.

The missing wiring is:

- `packages/gateway-discord/src/app.ts` posts only `message.content` to `POST /v1/interface/messages`; Discord attachments are ignored.
- `packages/acp-server/src/handlers/interface-messages.ts` currently parses only a required `content` field.
- `packages/gateway-discord/src/app.ts` and `packages/gateway-discord/src/discord-render.ts` send only text chunks on egress.
- `packages/acp-core/src/interface/delivery-request.ts` is text-only, so delivery-based final responses cannot yet carry media directly.

## Reference Implementations

### `../control-plane`

Useful reference files:

- `../control-plane/packages/gateway-discord/src/app.ts`
- `../control-plane/packages/control-plane/src/attachments.ts`
- `../control-plane/packages/gateway-discord/src/attachments.ts`
- `../control-plane/packages/gateway-discord/src/render.ts`

Relevant behavior:

- Outbound render frames extract image blocks and media refs, convert them to Discord files, and attach files to the edited/sent message.
- URL attachments can be downloaded into control-plane state under `media/attachments/<runId>`.
- Attachment resolution sanitizes filenames, preserves content type/size metadata where available, and converts URL refs to local file refs.

### `~/tools/openclaw`

Useful reference files:

- `~/tools/openclaw/extensions/discord/src/monitor/message-utils.ts`
- `~/tools/openclaw/extensions/discord/src/monitor/message-handler.process.ts`
- `~/tools/openclaw/extensions/discord/src/send.shared.ts`
- `~/tools/openclaw/extensions/discord/src/send.outbound.ts`

Relevant behavior:

- Inbound Discord media is resolved from attachments, stickers, and forwarded message snapshots.
- Downloads are guarded with max-byte limits, timeout handling, and SSRF policy.
- Image-only messages get explicit placeholder text such as `<media:image>` so the message is not treated as empty.
- Outbound media is sent as Discord file payloads with caption text and chunking.

## Proposed Contract

Extend interface message input to support optional attachment refs:

```ts
type InterfaceMessageAttachment = {
  kind: 'url' | 'file'
  url?: string
  path?: string
  filename?: string
  contentType?: string
  sizeBytes?: number
}
```

`POST /v1/interface/messages` should accept:

```ts
{
  idempotencyKey?: string
  source: {
    gatewayId: string
    conversationRef: string
    threadRef?: string
    messageRef: string
    authorRef: string
  }
  content: string
  attachments?: InterfaceMessageAttachment[]
}
```

Backward compatibility requirement: text-only messages must behave exactly as they do today.

## Phase 1: Media Contract

Task: `T-01237`

Update ACP/interface/runtime types to carry optional attachment refs from ingress to runtime dispatch.

Acceptance criteria:

- `POST /v1/interface/messages` accepts optional `attachments`.
- Input attempts/run metadata can retain attachment metadata for audit/debugging.
- Launch/dispatch code receives attachment refs along with the prompt.
- Existing text-only tests remain unchanged.

## Phase 2: ACP Media Materialization

Task: `T-01238`

Add a server-side attachment resolver in ACP, modeled on `../control-plane/packages/control-plane/src/attachments.ts`.

Acceptance criteria:

- HTTP(S) URL refs can be downloaded into ACP state.
- Local file refs are validated and preserved.
- Downloaded refs become local file refs usable by session runtimes.
- Filenames are sanitized.
- Max-byte limits are enforced.
- Failed attachment downloads are logged and do not crash unrelated text-only handling.

Rationale: materializing in ACP keeps persistent media handling out of the Discord gateway and makes the same path reusable for future gateways.

## Phase 3: Discord Image Ingress

Task: `T-01239`

Map `discord.js` `Message.attachments` into ACP interface message attachment refs.

Acceptance criteria:

- Text plus image messages produce `content` and `attachments`.
- Image-only messages produce placeholder content plus `attachments`.
- The existing source fields, idempotency key, placeholder message, and run correlation behavior remain unchanged.
- Tests cover at least image-only and text-plus-image inbound messages.

Suggested placeholder rule:

```ts
content = message.content.trim() || '<media:image> (1 image)'
```

For multiple or non-image attachments, use a count-aware placeholder similar to OpenClaw's media placeholder behavior.

## Phase 4: Discord Image Egress

Task: `T-01240`

Wire extracted render-frame media into Discord `files`.

Acceptance criteria:

- `renderToDiscord()` attaches files when editing/sending placeholder-driven render output.
- `deliverToDiscord()` attaches files for delivery-loop output.
- Inline base64 `image` blocks become Discord attachments.
- `media_ref` blocks are fetched by the gateway and become Discord attachments.
- If output fits in one chunk, files are attached to that message.
- If output spans multiple chunks, files are attached to the last chunk.
- Button components and reply references continue to work.

Use existing helpers:

- `extractImagesFromFrame`
- `extractMediaRefsFromFrame`
- `createDiscordAttachments`
- `fetchMediaAttachments`

## Phase 5: Validation And E2E

Task: `T-01241`

Add focused tests and perform an e2e path where possible.

Minimum automated coverage:

- Interface message parser accepts attachments.
- ACP materialization turns Discord CDN-like URLs into local file refs.
- Codex dispatch receives local images as `localImage`.
- Discord ingress sends attachment refs to ACP.
- Discord egress sends `files` for render-frame images/media refs.

Manual/e2e validation:

- If Discord credentials and a test binding are available, send an image-only Discord message and verify the agent receives an image.
- Trigger a tool or mocked render event that emits an image and verify Discord receives a visible file attachment.

Repo validation commands:

```bash
bun run --filter gateway-discord test
bun run --filter gateway-discord typecheck
bun run test
bun run typecheck
```

Run broader commands only after package-level validation is clean.

