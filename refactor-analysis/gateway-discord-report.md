# Refactor Analysis — `packages/gateway-discord`

Profile: **general** (event-driven Discord I/O gateway). Concurrency primitives exist (per-channel webhook serialization queue, live NDJSON subscriptions, throttled edits) but are already disciplined (message-passing via promise-chained queues, `AbortController` cancellation, immutable-ish event records). No `[T31]/[T32]` shared-mutable hazards surfaced. Not a data or perf package. **Not** a leaf — it has one external consumer (`acp-cli`), so `[M02]` Expand/Contract applies to any public-contract change.

## Summary

The package is in good shape internally: small, cohesive helper modules; a fat but well-tested `app.ts` orchestrator (2270 lines); 16 test files covering ingress, live-progress, claiming, throttle, reaction-cancel, webhooks, render, write-plan. The make-safe rung `[T40]` is already satisfied for the surfaces that matter.

The highest-leverage issue is the **public boundary**: `index.ts` re-exports ~40 names, but the only external consumer (`acp-cli/src/server-runtime.ts`) imports exactly **two** (`GatewayDiscordApp`, `envNumber`). Every test imports from deep module paths (`../app.js`, `../render.js`, …), never from `../index.js`. So the barrel is a leaky, unused surface that pins ~40 internal symbols as if they were contract.

Two concrete dead-structure findings fall out of that: `discord-render.ts` (`renderToDiscord`, 137 lines) is production-dead (only a test imports it; `app.ts` renders exclusively via webhooks and `write-plan`), and the `SessionEventsManager` subclass exists solely to carry a `@deprecated` `setDiscordMessage()` that is never called. Three `BindingIndex` methods are also never called. The `render.ts` top re-export block is a test-only pass-through.

## Public boundary — assessed FIRST

Verdict: **leaky** (over-exported), not unsound.

Evidence:
- External consumers (repo-wide grep for `from 'gateway-discord'`): only `packages/acp-cli/src/server-runtime.ts`, importing `{ GatewayDiscordApp, envNumber }`.
- `index.ts` exports ~40 names across 8 modules (BindingIndex, conversationKey, render internals, keyword parsing, SessionEventsManager, classifyDiscordError, renderToDiscord, ~16 types, …).
- No test imports `../index.js`; all use deep paths.

So ~38 of ~40 exports are dead public surface. They are not wrong, but they advertise internals as contract and resist internal change. Because there **is** a consumer, narrowing must go through `[M02]` (the dead exports can be dropped immediately since no consumer references them — Contract with zero migration cost — but doing so is a deliberate public-surface decision, hence deferred to a human).

The two real contract symbols are sound: `GatewayDiscordApp`/`GatewayDiscordAppOptions` is a clean constructor-injected class (client, fetchImpl, dashboardSnapshotImpl all overridable — substitution seams already present), and `envNumber` is a pure helper.

## Findings by mechanism (outside-in)

### B. Boundary

#### F1 — `index.ts` re-exports ~40 names; consumer uses 2 — narrow the barrel
- Location: `packages/gateway-discord/src/index.ts:1-49`
- Technique: `[T07]` align interface to actual usage; gated by `[M02]` Expand/Contract.
- Mechanism repaired: the public surface is decoupled from actual usage; internal modules are currently load-bearing as "contract" only because the barrel re-exports them.
- Direction: remove (narrow).
- Preservation rung: behavior-identical (exports are compile-time only); but it is a **public-surface** decision, so it must be a human/`[M02]` call, not an auto-apply.
- Falsifiable signal: after narrowing to the 2 used names (+ types `acp-cli` may need), `bun run typecheck` in both `gateway-discord` and `acp-cli` passes; repo grep shows no other importer.
- Risk: **Med** (low mechanical risk, but it is a contract change).
- API-impact: **public-surface**.
- Effort: S.
- Tests: existing suite unaffected (tests use deep paths). Add nothing.
- Contraindication: if any out-of-repo or dynamic consumer imports these, keep them. Verify before dropping. Safe middle ground: keep type re-exports, drop value re-exports that nothing imports.

### C. Seams & structure

#### F2 — `discord-render.ts` (`renderToDiscord`) is production-dead — remove
- Location: `packages/gateway-discord/src/discord-render.ts:1-137` (export wired at `index.ts:12`)
- Technique: `[T16]` collapse premature abstraction / de-abstract (remove dead module).
- Mechanism repaired: a whole rendering path (bot/Rex `channel.send`/`message.edit` with components) is kept alive only by a test. `app.ts` renders agent content exclusively through `webhooks` + `write-plan` (`renderViaWebhook`, `editPlaceholderProgress`, `deliverToDiscord`); the e2e test at `app.e2e.test.ts:1523` even comments that `renderToDiscord` is the bot/Rex path the gateway must NOT use.
- Direction: remove.
- Preservation rung: behavior-identical for production (no production caller). The `renderToDiscord` test must be deleted or repointed alongside.
- Falsifiable signal: delete file + `index.ts:12` export + the `app.e2e.test.ts` block that imports/exercises it; `bun test` and `bun run typecheck` stay green; runtime Discord behavior unchanged (covered by the webhook-path tests).
- Risk: **Med** (deletes a tested-but-unused path; verify the test is genuinely asserting "never use this" rather than a real path).
- API-impact: **public-surface** (`renderToDiscord` is re-exported).
- Effort: S.
- Tests: remove/repoint `renderToDiscord` test; rely on webhook-delivery tests.
- Contraindication: if any consumer or future component needs the non-webhook fallback render, keep it — but today nothing in `src` or `acp-cli` calls it.

#### F3 — `SessionEventsManager` subclass exists only for an unused `@deprecated` method — collapse
- Location: `packages/gateway-discord/src/session-events-manager.ts:20-31`
- Technique: `[T16]` collapse premature abstraction; `[T23]` remove middle man.
- Mechanism repaired: the subclass adds exactly one method, `setDiscordMessage()`, marked `@deprecated`, with **zero call sites** (grep for `.setDiscordMessage` in `src` is empty). `app.ts` instantiates this subclass but only calls inherited base methods (`subscribe`, `receive`, `getRunState`, `unsubscribe`). The subclass is a one-implementor wrapper around dead code.
- Direction: remove (drop the method; use `BaseSessionEventsManager` directly, or keep the re-export shell with no override).
- Preservation rung: behavior-identical (method never invoked).
- Falsifiable signal: replace the subclass with a direct re-export of `SessionEventsManager` from `hrc-frame-render`; `app.ts` keeps working; `session-events-manager.test.ts` / `.notice.test.ts` still pass (they exercise base behavior).
- Risk: **Low**.
- API-impact: **internal-only** in practice (the class is re-exported via `index.ts` but only used internally and by tests via deep path; removing the *method* changes only a dead deprecated API).
- Effort: S.
- Tests: existing manager tests; confirm none assert `setDiscordMessage`.
- Contraindication: if an external sink still calls `setDiscordMessage`, keep it — but no in-repo caller exists and it is already `@deprecated`.

#### F4 — `BindingIndex.getProjectIdFor` / `getBoundChannelIds` / `getChannelForProject` are never called — remove
- Location: `packages/gateway-discord/src/bindings.ts:23-26, 44-53, 55-68`
- Technique: `[T16]` de-abstract / dead-method removal.
- Mechanism repaired: three query methods on `BindingIndex` have no call sites anywhere (`src` grep for `.getProjectIdFor` / `.getBoundChannelIds` / `.getChannelForProject` is empty). `app.ts` uses only `replaceAll` and `getBindingFor`.
- Direction: remove.
- Preservation rung: behavior-identical.
- Falsifiable signal: delete the three methods; `bun run typecheck` + `bun test` green.
- Risk: **Low**.
- API-impact: **internal-only** (`BindingIndex` is re-exported but no external consumer uses these methods; `acp-cli` imports neither).
- Effort: S.
- Contraindication: none observed; if a future binding-routing feature is planned, these are speculative — remove now, re-add when needed.

#### F5 — `render.ts` top re-export block is a test-only pass-through — relocate/trim
- Location: `packages/gateway-discord/src/render.ts:1-12` (re-exports 9 names from `agent-action-render`; line 12 re-imports the 3 it actually uses)
- Technique: `[T23]` remove middle man; `[T03]` relocate by affinity.
- Mechanism repaired: `render.ts` re-exports `MAX_PREVIEW_CHARS, NOTICE_ICON, PRIMARY_ARG_KEY, TOOL_EMOJI, extractToolPreview, getToolEmoji` purely so `tests/render.test.ts` can import them from `../render.js`. Production `render.ts` only consumes `MAX_LINE_CHARS, formatNoticeLine, formatToolLine`. The package is acting as a re-export shim for another package's API, exercised only by its own tests.
- Direction: remove (drop the pass-through; point the test at `agent-action-render` directly).
- Preservation rung: behavior-identical; only the import path in `render.test.ts` changes.
- Falsifiable signal: `render.test.ts` imports those 6 symbols from `agent-action-render`; `render.ts` keeps only `import { MAX_LINE_CHARS, formatNoticeLine, formatToolLine } from 'agent-action-render'`; `bun test` green.
- Risk: **Low**.
- API-impact: **internal-only** (these are re-exported via `index.ts` too — dropping them is part of F1's narrowing, so sequence F5 with F1).
- Contraindication: if a downstream consumer relies on re-export through `gateway-discord`, keep them — but none does.

### E. Quality

#### F6 — `extractIngressFailureReason` is 4-deep nested `typeof`/`!== null` ladder — flatten with guards
- Location: `packages/gateway-discord/src/app.ts:89-115`
- Technique: `[T22]` guard clauses / flatten nesting.
- Mechanism repaired: a 4-level `if (typeof … === 'object' && … !== null)` pyramid walking `error.details.cause` then `error.message`. Each level can be an early bail or a small typed accessor (`asRecord`), removing the arrow shape.
- Direction: isolate (extract a `pickString(obj, key)` helper + early returns).
- Preservation rung: behavior-identical (same precedence: `details.cause` > `error.message` > raw trimmed).
- Falsifiable signal: same outputs for: valid JSON with cause, with message-only, non-JSON, empty; existing ingress-failure tests stay green.
- Risk: **Low**.
- API-impact: **internal-only** (module-private function).
- Effort: S.
- Contraindication: keep the exact fallback precedence — the comment documents it as load-bearing for user-facing error text.

#### F7 — verbatim frame→discordFiles extraction duplicated across delivery paths — extract helper
- Location: `packages/gateway-discord/src/app.ts:1970-1974` and `:2036-2040` (and a third near-identical form in `discord-render.ts:64-73`, which F2 removes)
- Technique: `[T15]` extract missing abstraction (duplicated intent).
- Mechanism repaired: the 4-line sequence `extractImagesFromFrame → extractMediaRefsFromFrame → fetchMediaAttachments → createDiscordAttachments → filesPayload` is copy-pasted in `deliverToDiscord` and `renderViaWebhook`. A single `async buildFrameFilesPayload(frame): Promise<{ files?: AttachmentBuilder[] }>` collapses both.
- Direction: relocate/extract (one private method or a free function in `attachments.ts`/`render.ts`).
- Preservation rung: behavior-identical — must preserve the exact ordering (`...createDiscordAttachments(images), ...mediaFiles`) and the `length > 0 ? { files } : {}` shape.
- Falsifiable signal: both call sites produce identical payloads; image/media e2e tests stay green.
- Risk: **Low**.
- API-impact: **internal-only**.
- Effort: S.
- Contraindication: if F2 lands, the `discord-render.ts` copy disappears on its own; do F2 first to avoid extracting into dead code.

## Deliberately left alone (where-NOT)

- **`app.ts` size (2270 lines).** It is one cohesive orchestrator (Discord events ⇄ ACP HTTP ⇄ live progress ⇄ placeholders). Splitting it (e.g. extracting a `PlaceholderStore` or `LiveSubscriptionManager`) is a **redesign**, not a refactor — the placeholder lifecycle is tightly coupled across timers, subscriptions, and delivery, and the test suite asserts the integrated behavior. High-churn, behavior-risking; defer to a deliberate design pass, not an auto-apply.
- **Constructor `new Client(...)`, `fetch`, `fetchDashboardSnapshotViaWebSocket` defaults.** These are already substitution seams (`options.client`, `options.fetchImpl`, `options.dashboardSnapshotImpl`). `[T01]` is already done; no action.
- **`PendingPlaceholder` (~25 fields) as a parameter/state object.** Looks like `[T21]` parameter-object bait, but it is the reified run-lifecycle state machine (`[T10]` already done): pending → claimed → editing → final/failed/cancelled, with timers. The flag set (`editDisabled`, `webhookGone`, `cancelRequested`, …) is genuinely independent state, not a clump to bundle. Leave it.
- **`config.MEDIA_MIME_EXT` vs `render.ts:457 mimeToExt`.** Superficially duplicate, but different scope and fallback (`media_N.ext` with `.bin` for media attachments vs frame-image filenames with `.bin`). Consolidating couples two unrelated rendering concerns and risks changing filenames. Load-bearing divergence — leave it (or note only).
- **`discord-errors.classifyDiscordError` status ladder.** A linear `403/404/429/4xx/5xx → log level` map. Could become a table, but it is read-once, log-only, and stable; `[T19]` dispatch would add indirection for no variation. Leave.
- **Concurrency in `webhooks.ts` (per-channel `enqueue` promise chain, `withRateLimitRetry`).** Correct message-passing serialization; no shared-mutable hazard. The `cache`/`webhookAvatarKeys` maps are confined to the closure and mutated only inside the serialized queue. No `[T31]/[T32]`. Leave.

## If applying: outside-in sequence

1. **F1 (boundary)** — decide the narrowed public surface with a human (`[M02]` Contract). This frames F2/F3/F5 (their `index.ts` exports go away as part of it).
2. **F2** — delete `discord-render.ts` + its export + the `renderToDiscord` test usage.
3. **F5** — repoint `render.test.ts` to `agent-action-render`; trim the `render.ts` re-export block.
4. **F3** — collapse the `SessionEventsManager` subclass (drop dead `setDiscordMessage`).
5. **F4** — drop the three unused `BindingIndex` methods.
6. **F7** — extract the frame→files helper (after F2 so you don't extract into a dead third copy).
7. **F6** — flatten `extractIngressFailureReason`.

(Auto-applicable now without the human boundary decision: F3, F4, F6, F7 — all internal-only + Low. F1, F2, F5 touch the public barrel/exports and are deferred.)

## Safety checklist

- [ ] `bun test` green in `packages/gateway-discord` (16 test files).
- [ ] `bun run typecheck` green in `packages/gateway-discord` **and** `packages/acp-cli` (only external consumer).
- [ ] Repo grep `from 'gateway-discord'` re-confirmed before dropping any export (F1/F2/F5).
- [ ] `biome` lint clean — F6's `typeof` accessor must not trip `useValidTypeof` (compare against `'object'`/`'string'` literals only, no dynamic typeof comparison).
- [ ] F7 preserves exact files-payload shape and attachment ordering (snapshot the two call sites' output).
- [ ] No behavior change observable in a Discord round-trip (validate via the `discord-virtu` skill for any change that touches delivery/render paths — F2, F7).
