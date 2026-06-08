# Refactor Analysis — `packages/gateway-discord`

**Scope:** `packages/gateway-discord/src/*.ts` (production sources only; `*.test.ts` and `dist/` excluded)
**Total source lines analyzed:** 4,547 across 19 files
**Date:** 2026-06-07
**Mode:** ANALYSIS ONLY (no source edits)

---

## Scorecard

| Dimension | Grade | Notes |
|---|---|---|
| SRP (Single Responsibility) | D | `app.ts` (2,117 LOC) is a god-class: Discord client wiring, ingress routing, keyword/thread provisioning, placeholder lifecycle, live SSE subscription + reconnect, progress throttling, delivery polling, webhook rendering, HTTP client, and timeout diagnostics all in one class. |
| OCP (Open/Closed) | C | Several type-keyed `switch`/if-chains (`renderBlock`, degraded-reason dispatch, phase→emoji) that grow with each new variant. |
| LSP | A | No broken inheritance; the one `extends` (`SessionEventsManager`) only adds a deprecated convenience method. |
| ISP | B | Interfaces are mostly lean. `PendingPlaceholder` is a 25-field mutable record (state-bag smell) rather than a fat *interface* per se. |
| DIP | B- | `fetchImpl`/`dashboardSnapshotImpl`/`client` are injectable (good), but `new BindingIndex()`, `new SessionEventsManager()`, `createWebhookManager()`, and `new AbortController()`/`new WebSocket()` are hardcoded inside the class. |
| Function size / complexity | D | `handleMessageCreate` (~172 LOC), `runLiveSubscription` (~80 LOC), `buildProgressBubble` (~145 LOC), `describePendingPlaceholderTimeout`, `deliverToDiscord` all far exceed the 50-line guideline. |
| Duplication | C | Webhook-vs-channel edit fallback duplicated across `failPlaceholder`/`noticePlaceholder`; image/media-extraction + chunk-send loop duplicated across `deliverToDiscord`/`renderViaWebhook`/`discord-render.ts`. |
| Dead/legacy code | C | `discord-render.ts` (`renderToDiscord`, 137 LOC) is exercised only by tests; `setDiscordMessage` is `@deprecated`; `render.ts` re-exports an `@internal` `NoticeBlock` stub marked "remove once Phase 2 ships". |
| Primitive obsession | C | `sessionRef` flows as a `string` (`scopeRef/lane:id`) in some paths and a structured `InterfaceSessionRef` in others; ad-hoc `unknown`-narrowing helpers (`errorField`, `errorValue`) duplicated across files. |

**Overall: C-** — Functionally rich and well-tested, but `app.ts` concentrates far too many responsibilities and the placeholder lifecycle is managed through a sprawling mutable state-bag with scattered timer bookkeeping.

---

## Priority Refactorings

### P1 — Decompose `GatewayDiscordApp` (`app.ts:391-2094`) — SRP
The class owns at least seven distinct responsibilities. Extract collaborators:
- **LiveSubscriptionManager** (`startLiveSubscription`/`runLiveSubscription`/`processLiveEventBuffer`/`processLiveEventLine`/`reconcile…`, `app.ts:1032-1382`) — SSE connect, reconnect/backoff, NDJSON buffering, event parse + claim.
- **PlaceholderRegistry** (`registerPendingPlaceholder`/`removePendingPlaceholder`/`claimPendingPlaceholder`/`findPlaceholderByHrcRunId`/`clearPlaceholderTimers`, three parallel `Map`s `app.ts:405-410`) — placeholder index + timer lifecycle.
- **ProgressEditScheduler** (`scheduleProgressEdit`/`flushProgressEdit`/`disableProgressEditsTemporarily`, `app.ts:1249-1353`) — throttle/rate-limit state machine.
- **AcpHttpClient** (`fetchJson`/`postJson` + the run-lookup payload shaping, `app.ts:2073-2093`).
**Impact:** high (testability, comprehension). **Risk:** high (touches async ordering, wiring). **Effort:** L. `behaviorPreserving=false`.

### P2 — Extract `handleMessageCreate` (`app.ts:608-780`, ~172 LOC) — Long Method
Currently does: guild/bot/thread filtering, binding resolution + double-refresh, route resolution, sessionRef derivation, placeholder creation, HTTP POST, and a 5-branch admission-result handler. Split into `shouldHandle()`, `resolveBindingForMessage()`, `dispatchIngress()`, and `applyAdmissionResult()`.
**Impact:** high. **Risk:** med-high (error/async paths). **Effort:** M. `behaviorPreserving=false`.

### P3 — Replace `PendingPlaceholder` state-bag + scattered timers (`app.ts:220-245`) — Primitive Obsession / SRP
25 mutable fields including five raw timer handles cleared/re-armed in ≥6 methods. Encapsulate the timer set behind a small `PlaceholderTimers` object with `clearAll()`/`armRunTimeout()` etc., and split correlation fields (`expectedHrcRunId`/`expectedHostSessionId`/`expectedGeneration`) into a `Correlation` value object.
**Impact:** high (eliminates the most error-prone surface). **Risk:** med. **Effort:** M. `behaviorPreserving=false`.

### P4 — Deduplicate webhook/channel edit fallback (`failPlaceholder` `app.ts:2008-2036`, `noticePlaceholder` `app.ts:2038-2071`) — Duplication
Both methods share the identical "if webhookId → webhook.editMessage else fetch channel → fetch message → message.edit, swallow errors" skeleton; only the rendered content differs. Extract `editPlaceholderMessage(ui, content)`.
**Impact:** med. **Risk:** low. **Effort:** S. `behaviorPreserving=false` (consolidates two best-effort error paths).

### P5 — Deduplicate attachment-extraction + chunk-send loop (`deliverToDiscord` `app.ts:1812-1834`, `renderViaWebhook` `app.ts:1879-1910`, `discord-render.ts:64-135`) — Duplication
The `extractImagesFromFrame` + `extractMediaRefsFromFrame` + `fetchMediaAttachments` + `createDiscordAttachments` + per-chunk "files only on last chunk" loop is repeated three times. Extract `buildFrameFiles(frame)` and `sendChunks(send, chunks, files, identity)` helpers.
**Impact:** med. **Risk:** low-med. **Effort:** M. `behaviorPreserving=false`.

---

## Code Smells

| # | Location | Smell / Principle | Detail | Risk | Effort |
|---|---|---|---|---|---|
| 1 | `app.ts:391-2094` | God Class / SRP | 2,117-LOC class, 7+ responsibilities, 3 parallel placeholder `Map`s. | High | L |
| 2 | `app.ts:608-780` | Long Method | `handleMessageCreate` ~172 LOC, deep nesting + 5-branch admission switch. | High | M |
| 3 | `app.ts:1079-1160` | Long Method / deep nesting | `runLiveSubscription` mixes URL build, reader loop, reconnect backoff, finally-cleanup; nesting ≥4. | Med | M |
| 4 | `app.ts:1480-1539` | Long Method / OCP | `describePendingPlaceholderTimeout` is a status→message if-ladder (`queued`/`pending`/`running`/`failed`…). | Low | M |
| 5 | `app.ts:220-245` | State-bag / Primitive Obsession | `PendingPlaceholder` 25 mutable fields incl. 5 raw timer handles. | Med | M |
| 6 | `app.ts:89-115` | Deep nesting / `unknown` narrowing | `extractIngressFailureReason` 5-level nested type guards. | Low | S |
| 7 | `app.ts:199-216`, `webhooks.ts:110-141` | Duplication | `errorField`/`errorValue` + `isDiscordRateLimit`/`isDiscordWebhookGone` vs `isInvalidWebhookError`/`retryAfterMs` duplicate status/code extraction across files. | Low | S |
| 8 | `app.ts:65-79` | Magic numbers / config | Hardcoded `VIRTU_BOT_ID` default `'1165644636807778414'`, several `*_MS` constants and `CANCEL_REACTION_NAMES` set — mostly named (good) but the bot id literal is buried. | Low | S |
| 9 | `app.ts:782-829` | Primitive Obsession | `sessionRef` represented as both `string` and `InterfaceSessionRef`; `canonicalSessionRefString` vs `resolveSteeringAvailability` build the canonical key two different ways (`/lane:${laneIdFromRef(...)}` vs `/lane:${sessionRef.laneRef}`) — latent inconsistency. | Med | S |
| 10 | `render.ts:75-144` | OCP | `renderBlock` `switch(block.t)` over 8 variants with `notice` bolted on via `ExtendedRenderBlock` cast. | Low | M |
| 11 | `render.ts:300-445` | Long Method | `buildProgressBubble` ~145 LOC with three nested closures + four shrink-to-fit while-loops. | Med | L |
| 12 | `render.ts:101-136` & `render.ts:308-328` | Duplication | tool-block rendering (askUserQuestion / formatToolLine / failed flag) duplicated between `renderBlock` and `buildProgressBubble`, each re-casting to `… & { input?: Record<string,unknown> }`. | Low | M |
| 13 | `write-plan.ts:115-161` | OCP / Long Method | degraded-reason dispatch (`launch_signalled`/`launch_failed`/else) with repeated `'x' in degraded` structural probes. | Low | M |
| 14 | `write-plan.ts:207-216` | Magic / OCP | phase→emoji ladder (`final`/`error`/`permission`/default) — same pattern likely repeated elsewhere. | Low | S |
| 15 | `discord-render.ts:26-137` | Dead/Legacy code | `renderToDiscord` referenced only by tests + re-export; production delivery uses webhooks. Candidate for removal or test-only relocation. | Med | M |
| 16 | `session-events-manager.ts:25-30` | Dead/Deprecated | `setDiscordMessage` `@deprecated`; verify no production caller before removal. | Low | S |
| 17 | `render.ts:22-30` | Tech-debt stub | `@internal NoticeBlock` stub explicitly flagged "remove once Phase 2 (T-01372) ships". | Low | S |
| 18 | `app.ts:163-181` | Backward-compat branch | `sessionRefFromBinding` reads a `legacy.scopeRef/laneRef` shape; dead if all bindings migrated. | Low | S |
| 19 | `app.ts:455-458` / `424-481` | DIP | Constructor hardcodes `new BindingIndex()`, `new SessionEventsManager(...)`, `createWebhookManager(...)`; only `client`/`fetch`/`dashboard` injectable. | Med | M |
| 20 | `app.ts:309-364` | Long Method / placement | `fetchDashboardSnapshotViaWebSocket` is a 56-LOC WebSocket promise-wrapper living at module scope in the app file; belongs in its own transport module. | Low | S |

---

## Quick Wins (low risk, high clarity)

- **QW1 — Extract `editPlaceholderMessage(ui, content)`** to collapse the duplicated webhook/channel fallback in `failPlaceholder` + `noticePlaceholder` (`app.ts:2008-2071`). Behavior-preserving only if the two best-effort error skeletons are byte-identical (they swallow differently around the `-#` subtext prefix — treat as `behaviorPreserving=false`).
- **QW2 — Hoist `VIRTU_BOT_ID` literal** into `config.ts` next to the other env-backed constants (`app.ts:65`). Pure constant relocation. `behaviorPreserving=true`.
- **QW3 — Unify status/code extraction** by reusing one `httpErrorField(error, key)` helper across `app.ts:199-216` and `webhooks.ts:110-141`. `behaviorPreserving=true` (identical logic, same return shape).
- **QW4 — Extract `tool`-block rendering** into a shared `renderToolBlock(block, { compact })` used by both `renderBlock` and `buildProgressBubble` (`render.ts`). `behaviorPreserving=false` (shared call site changes two outputs; verify under tests).
- **QW5 — Name the per-chunk "files on last chunk only" loop** as `sendChunks(...)` (`app.ts` + `discord-render.ts`). `behaviorPreserving=false`.

---

## Tech Debt Register

| Item | Location | Tracking | Action |
|---|---|---|---|
| `NoticeBlock` stub | `render.ts:22-30` | T-01372 (Phase 2) | Remove stub + `ExtendedRenderBlock` casts once `notice` lands in `types.ts`. |
| `setDiscordMessage` deprecated | `session-events-manager.ts:25` | — | Migrate sinks to `setSinkMetadata`, then delete. |
| `renderToDiscord` legacy path | `discord-render.ts` | — | Confirm no runtime caller; relocate to tests or delete export. |
| `legacy.scopeRef/laneRef` binding shape | `app.ts:163-181` | — | Confirm all persisted bindings use `sessionRef`; drop legacy branch. |
| Dual sessionRef representation | throughout `app.ts` | — | Introduce a `CanonicalSessionRef` value object; converge the two key-building spellings (`app.ts:164` vs `app.ts:905`). |

---

## Safety Checklist (for the apply stage)

- [ ] **Live-progress timer behavior** — any change to `PendingPlaceholder` timer fields (P3) must preserve exact arm/clear ordering in `claimPendingPlaceholder`, `processLiveEventLine` (turn_end / AskUserQuestion), `flushProgressEdit`, and `stop()`. Covered by `app.live-progress*.test.ts`, `app.typing-indicator.test.ts`.
- [ ] **Admission-result branches** — `handleMessageCreate` split (P2) must keep `accepted_in_flight`/`admission_pending`/`rejected`/`runId` handling and the deferred-cancel replay (`app.ts:758-760`). Covered by `app.e2e.test.ts`, `app.reaction-cancel.test.ts`, `app.live-progress-claim.test.ts`.
- [ ] **SSE reconnect/backoff** — extracting LiveSubscriptionManager (P1) must preserve `lastHrcSeq+1` resume, exponential backoff cap, and finally-block `releaseLock`. Covered by `app.live-progress*.e2e.test.ts`.
- [ ] **Chunk/file dedup (P5)** — confirm "files attach to last chunk only" and "first chunk edits placeholder, rest send fresh" invariants in both webhook and fresh-delivery paths. Covered by `render.test.ts`, `write-plan.test.ts`, `app.e2e.test.ts`.
- [ ] **Webhook vs channel fallback (P4)** — preserve best-effort silence on failure (never throw a secondary error). Covered by `webhooks.test.ts`.
- [ ] **Canonical sessionRef key (smell #9)** — if converging the two spellings, verify `resolveSteeringAvailability` still matches dashboard `sessionRef` exactly (currently uses raw `laneRef`, others strip `lane:` prefix). Behavior-sensitive — add a targeted test before touching.
- [ ] Run `pnpm --filter gateway-discord build && pnpm --filter gateway-discord test` after every step.

---

*Analysis only — no source files were modified.*
