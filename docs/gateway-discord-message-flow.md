---
id: agent-control-plane/gateway-discord-message-flow
title: gateway-discord Message Flow and Virtu Testing
kind: guide
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# gateway-discord message flow and virtu testing

`gateway-discord` (`packages/gateway-discord`) is the Discord interface
gateway. It is **embedded inside `acp-server`** — there is no separate
gateway-discord process to start or restart independently; `acp server restart` restarts both. It maps Discord channels/threads to ACP session
scopes and renders agent activity and lifecycle events back into Discord.

## Inbound flow: Discord message → ACP run

1. **`Events.MessageCreate`** fires in `app.ts` (`handleMessageCreate`).
   Thread-creation system messages are skipped; bot messages are dropped
   unless they come from the configured virtu test bot
   (`DISCORD_VIRTU_BOT_ID`, default `1165644636807778414`) or are the
   gateway's own outbound webhook messages.
2. The message's `(channelId[, threadId])` is turned into a
   `(conversationRef, threadRef)` pair (`bindings.ts`,
   `channel:<id>` / `thread:<id>`) and looked up in an in-memory
   `BindingIndex`, refreshed on a fixed interval
   (`DEFAULT_BINDINGS_REFRESH_MS` = 30s) and on lookup miss. No binding, no
   ingest — the message is silently ignored.
3. **Keyword routing** (`keywords.ts`): a leading `nt <prompt>` in a bound
   channel starts a new Discord thread scoped to its own session lane
   (`buildDiscordThreadLaneRef`) and auto-creates a thread-scoped interface
   binding via `POST /v1/interface/bindings`. Other content passes through
   unchanged (`resolveDiscordIngressContent`, `attachment-ingress.ts` maps
   Discord attachments).
4. A **placeholder message** (`⏳ Processing`) is posted immediately so the
   channel shows something is happening, and registered as a
   `PendingPlaceholder` keyed by session ref / message id.
5. The gateway resolves an `InputIntent` if there's already an active run
   for that session (`resolveInputIntent`): `contribute_to_active_run` with
   `fallback: 'reject'` when a live placeholder is tracked, or
   `fallback: 'queue'` when the mobile dashboard snapshot shows an active
   turn accepting input — otherwise no intent (ordinary new-turn admission).
6. The gateway `POST`s to **`/v1/interface/messages`** on its own
   `acp-server` host, with `idempotencyKey: discord:message:<messageId>`,
   the `source` (gatewayId, conversationRef, threadRef, messageRef,
   authorRef), `content`, optional `intent`, and any attachments.
7. On success, the response's `runId` (if present) is bound to the
   placeholder, which then tracks the run via the live SSE subscription
   (step below). `admission.kind` of `accepted_in_flight` or
   `admission_pending` becomes a Discord notice; `rejected` fails the
   placeholder with the rejection reason. A thrown fetch or non-2xx response
   fails the placeholder visibly rather than leaving a stale
   `⏳ Processing` forever.

## Outbound flow: agent activity → Discord

Two parallel outbound paths exist:

- **Delivery queue poll** (`runDeliveryLoop`): polls
  `GET /v1/gateway/:gatewayId/deliveries/stream?since=<cursor>` on an
  interval (`DEFAULT_DELIVERY_POLL_MS` = 1s busy / `DEFAULT_DELIVERY_IDLE_MS`
  = 2.5s idle), processes each delivery, and advances the cursor. This is the
  general-purpose gateway delivery drain.
- **Live per-run progress** (`SessionEventsManager` + `runLiveSubscription`):
  for every active interface binding, the gateway opens an NDJSON SSE
  subscription to `GET /v1/session-refs/events?sessionRef=...&follow=true`
  on its own host, reconnecting with exponential backoff
  (1s → 5s cap) on stream close. Live HRC lifecycle events
  (`adaptHrcLifecycleEvent`) drive throttled placeholder edits
  (`LIVE_PROGRESS_EDIT_THROTTLE_MS` = 1500ms, initial flush at 150ms) so the
  placeholder message updates in place as the agent works, instead of
  spamming new messages.

A reaction of `x` / `cancel` / `❌` on an active placeholder cancels the
underlying run via `POST /v1/runs/:runId/cancel` (`cancelPlaceholderRun`).

## Lifecycle cards (system-events → Discord)

Separately from per-run progress, gateway-discord polls
`GET /v1/admin/system-events?afterEventId=<cursor>&limit=200` globally (no
per-kind filter — the cursor always advances past every event kind so
unrelated kinds are never re-fetched) and dispatches by kind family:

- `job.*` → the fixed `#job-runs` channel (`ACP_DISCORD_JOB_RUNS_CHANNEL_ID`),
  rendered by `buildJobRunCard` (`job-runs.ts`).
- `wrkq.*` / `wrkf.*` → the fixed `#work-activity` channel
  (`ACP_DISCORD_WORK_ACTIVITY_CHANNEL_ID`), rendered by
  `buildWorkActivityCard` (`work-activity.ts`).

Both channels are **host config, not interface bindings** — the binding
store is never consulted for this egress, and the cursor primes to the
current tail on (re)start so a restart never floods a channel with
historical events (best-effort near-real-time; events emitted while the
gateway is down are skipped, not backfilled). Full design:
`docs/discord-event-architecture.md` in the repo (the invariant: the
system-events store is an **immutable observer projection, never
authority** — a failed/duplicate/slow card post must never change
authoritative task/run state).

## Testing with the virtu bot

`virtu` is a second Discord bot identity used as an automated test client —
it is explicitly allowed through the `message.author.bot` filter
(`VIRTU_BOT_ID`) so scripted messages are treated as real user ingress
instead of being dropped as gateway noise.

Send a message as virtu:

```bash
CP_CHANNEL_ID=<discord-channel-id> ./scripts/virtu-send.sh "ping"
```

`scripts/virtu-send.sh` reads the virtu bot token from Consul
(`cfg/dev/_global/discord/virtu_bot_token`) and posts via the `discord-chat`
CLI. `scripts/virtu-typing-smoke.sh` and `scripts/virtu-thread.sh` cover
typing-indicator and thread-creation smoke variants.

To validate the round trip end to end:

1. Bind the target channel to a fresh task-scoped session:
   ```bash
   acp admin interface binding set --gateway acp-discord-smoke \
     --conversation-ref channel:<channel-id> --project <projectId> \
     --scope-ref agent:<agent>:project:<project>:task:<task> \
     --lane-ref main --json
   ```
2. Send via `virtu-send.sh` (or `acp send --scope-ref ... --lane-ref main`
   for non-Discord-shaped input).
3. Confirm the ACP session/run picked it up:
   ```bash
   acp session resolve --scope-ref <scopeRef> --lane-ref main --json
   acp session runs --session <sessionId> --json
   ```
4. Read the message back from the real Discord channel via the REST API:
   ```bash
   TOKEN=$(consul kv get cfg/dev/_global/discord/master_token)
   curl -sS -H "Authorization: Bot $TOKEN" \
     "https://discord.com/api/v10/channels/<channel-id>/messages?limit=5" \
     | jq -r '.[] | {author: .author.username, ts: .timestamp, content}'
   ```

The run's `metadata.meta.interfaceSource.bindingId` is the authoritative
proof a specific binding routed the inbound message — match it against the
binding created in step 1. Per repo policy (AGENTS.md "Discord Gateway
Validation"), any change to Discord gateway behavior requires this kind of
real-Discord smoke; mocked/fake Discord clients only count for automated
tests, never as the manual validation step.

Standard dev gateway id: `acp-discord-smoke`. A worked multi-case example
(steering/contribution semantics under `HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED`)
lives in `docs/active-run-contribution-virtu-smoke-checklist.md`.
