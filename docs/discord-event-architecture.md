# Discord Event Architecture (ACP lifecycle → Discord cards)

How ACP lifecycle telemetry becomes Discord embed cards, and how to add a card
for a new event kind. First shipped by T-05245 (`job.dispatched` /
`job.completed` → a fixed `#job-runs` channel).

## Invariant

The **system-events store is an immutable observer projection**, not authority.

- Emit **only after** the authoritative transition has committed.
- **Never** append from a store that owns authority (e.g. `acp-jobs-store`) —
  emit from the ACP-server layer that already observes the committed transition.
- A failed, duplicate, or slow emit/render/post must **never** change the
  authoritative state. Discord delivery failure is logged and dropped.

## The three layers

### 1. Emit (acp-server only)

`packages/acp-server/src/jobs/lifecycle-events.ts` —
`createJobLifecycleEmitter` appends to `deps.adminStore.systemEvents`.

- Idempotency: `systemEvents.existsWithPayloadField({ kind, field, value })`
  before append (keyed on a stable payload id, e.g. `jobRunId`). Safe across
  repeated reconciler ticks and process restarts.
- Wired in `cli.ts`: consumes `jobsScheduler.tick()` return (every touched run),
  the output-reconciler `onJobRunSettled` callback, and the manual run handler
  (`handlers/admin-jobs.ts`). Synchronous-flow terminals backfill the start
  event before the completion event.
- Optional captured agent output via
  `getRunFinalAssistantText({ getRun, hrcDbPath }, runId)`
  (`jobs/run-final-output.ts`), carried as `finalResponse` (truncated).
- `job.dispatched` and `job.completed` carry available run timing fields
  (`triggeredAt`, `claimedAt`, `dispatchedAt`, `completedAt`). `durationMs` is
  emitted only on terminal events when trigger and completion timestamps are
  valid and non-negative.

`packages/acp-server/src/jobs/wrkq-event-emitter.ts` observes committed wrkq v2
webhooks from `POST /v1/webhooks/wrkq` and appends recognized `wrkq.*` /
`wrkf.*` lifecycle events. It is also observer-only: malformed recognized
enrichment objects are rejected by the webhook parser before both system-events
and jobs-inbox writes, duplicate system-events are suppressed by
`canonicalEventId`, and append failure never changes the webhook response or
wrkq/wrkf/jobs authority.

The wrkq/wrkf system-event payload is a bounded renderer contract, not the raw
producer blob. It preserves existing identity/context fields and may include:

- `comment`: `id`, optional `author`, and sanitized/truncated `preview`.
- `move`: `from_container_path` and `to_container_path`.
- `archive`: compact prior state/path plus optional sanitized `reason`/`note`.
- `changes`: for `state`, `title`, `labels`, `priority`, `due_at`, `start_at`,
  `container_path`, `slug`, and `kind` only.
- `workflow`: compact template/instance/state/transition/action/run metadata,
  roles, next actions, blocked obligations, and checks.

Control characters are stripped, whitespace is collapsed, preview/reason/note
strings are capped at 240 characters, compact labels at 80 characters, and
compact arrays at five items. Raw comment bodies, descriptions/specifications,
workflow payloads, evidence, check output, and arbitrary nested producer data do
not leave the system-events projection. Gateway-discord consumes only this
system-event payload and must not read wrkq/wrkf authority stores, job stores, or
interface bindings to enrich cards.

### 2. Store + HTTP (generic, reusable)

`packages/acp-admin-store/src/open-store.ts` — `createSystemEventsStore`:

- `append(...)`, `existsWithPayloadField(...)`, and
  `list({ kind, projectId, occurredAfter, occurredBefore, afterEventId, limit })`.
- `afterEventId` is a **monotonic `event_id` (rowid) cursor** — gap-free, with no
  same-`occurredAt` skip (occurredAt can collide; rowid cannot).
- HTTP: `GET/POST /v1/admin/system-events`
  (`handlers/admin-system-events.ts`, routed in `routing/exact-routes.ts`).
- After editing acp-admin-store, **`bun run build` it** — acp-server resolves the
  built `.d.ts`, not source.

### 3. Render + egress (gateway-discord, embedded in acp-server)

`packages/gateway-discord/src/job-runs.ts` (`buildJobRunCard`, pure event →
embed) and `app.ts` (`pollJobRunsOnce` / `runJobRunsLoop`):

- Polls `GET /v1/admin/system-events?afterEventId=&limit=200` **globally** (no
  kind filter; filters client-side and advances the cursor past every event so
  unrelated kinds aren't re-fetched).
- Primes the cursor to the current tail on (re)start → no historical flood.
  In-memory cursor ⇒ **best-effort near-real-time** (events while the gateway is
  down are skipped).
- Posts via the existing webhook manager to **one fixed channel**. The interface
  binding store is **never** consulted — posting is global and unfiltered.
  Failures log `gw.jobruns.post_failed` and are dropped.

## Config

Channel is **host config, not a binding**:

- env `ACP_DISCORD_JOB_RUNS_CHANNEL_ID` → Consul
  `cfg/dev/_global/discord/job_runs_channel_id`. Unset disables the poll loop.
- gateway-discord is **embedded in acp-server** (no separate process); restart
  with `acp server restart`. Discord secrets live in Consul
  (`cfg/dev/_global/discord/*`).

## Adding a card for a new event kind

1. **Emit** the new event in acp-server at the layer that observes the committed
   transition; guard idempotency with `existsWithPayloadField` on a stable id.
2. **Render**: extend the gateway render path. Today it only recognizes `job.*`
   (`buildJobRunCard` returns `undefined` otherwise) — generalize it to a
   kind→builder dispatch map, or add a sibling builder. Same channel = reuse the
   loop; different channel = add a config key + poll loop.
3. **Test** (bun:test, mirror existing): store cursor/exists, emitter
   (emit-once + idempotent + optional fields), card builder shape, poll loop
   (only relevant kinds posted, cursor advance, binding-bypass).
4. **Validate for real** (mandatory, see AGENTS.md "Discord Gateway
   Validation"): trigger a real event, confirm the card lands in Discord, read
   it back via the Discord REST API. Build the system-events store, then
   acp-server, then `acp server restart`.

## Card format (current; iterate freely)

Embed, `username = "<agent> · jobs"`, dicebear avatar thumbnail
(`avatarFor` in `identity.ts`). `Task` is parsed from `scopeRef` via
`parseScopeRef` (agent-scope).

- **Started**: title `▶ Job started · <slug>` (blurple); fields
  `Agent, Project, Task, Trigger, Run`; subtitle = job description (one line) or
  status phrase.
- **Completed**: status in the title — `✓ Job <status> · <slug>` (green) /
  `✗ Job failed · <slug>` (red). Fields `Agent, Project, Task` (+ `Error` on
  failure). The agent's final response renders as **markdown (unfenced)** in the
  embed description (4096 cap) under a `-#` small-text subtitle. Caveat: unfenced
  ⇒ code/ASCII/whitespace reflows; a future option is to preserve fenced code
  blocks from the reply while rendering the rest.

## Follow-ups

- Generalize the gateway render path to a kind→builder dispatch map.
- Hybrid render: preserve fenced code blocks from agent replies.
- Optional per-event-family channels (each needs a config key + poll loop, or a
  per-kind channel map).
