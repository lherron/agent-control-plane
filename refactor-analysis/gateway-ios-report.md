# Refactor Analysis — `packages/gateway-ios`

Read-only analysis. No source modified. Every `src/*.ts` file read in full (18 source files + tests skimmed for import topology).

## Summary

`gateway-ios` is a standalone Bun HTTP+WebSocket server that projects HRC lifecycle
events / hrcchat messages into SwiftUI-friendly DTOs for a mobile client. It ships as a
**binary** (`bin: gateway-ios -> src/main.ts`) and as a **module** consumed at runtime by
`acp-server` (which spawns/embeds it). A repo-wide grep for programmatic importers of the
package surface (`from 'gateway-ios'`, `createGatewayIosModule`, every public type) found
**zero in-repo consumers** outside build/boundary/publish scripts. Internal tests import
sibling modules directly (`../routes.js`, `../event-reducer.js`, …), never via `index.ts`.

Implication for profile: although the runtime shape is a server with a concurrent
event-pump, from a *consumer* standpoint the package is effectively a **leaf** — nothing
binds to the bulk of `index.ts`. The single most valuable structural move is therefore at
the **boundary**: `index.ts` re-exports ~14 modules' worth of internal pipeline machinery
(reducer state types, projector, event-filter, pump internals, WS data shapes) that no one
imports. That is a fat, speculative public surface.

The pipeline code itself is in good shape: the reducer was already de-duplicated via
`upsertFrame`, payload extraction is typed (no `any`), the dispatch switch is clean, and the
event-pump's two-cursor race-safety is carefully built. Findings below are mostly small
boundary/de-abstraction/dedup items, plus two genuinely deferred public-surface items.

Profile applied: **general + leaf** (drop M02 Expand/Contract for the boundary narrowing —
no consumers to migrate). The concurrent swaps (T31/T32) were pressure-tested against the
event-pump and found **not applicable** (see Deliberately left alone).

## Public boundary — assessed first

Verdict: **leaky (fat / speculative)**.

`src/index.ts` exports the module lifecycle and frozen DTO contracts (legitimate) **plus**
the entire internal projection pipeline: `createReducerState`/`reduce` and `FrameState`/
`ReducerState`/`FrameUpdate`/`ReducerResult`; `projectTimeline`/`projectIncremental`/
`ProjectionResult`; `runEventPump`/`EventPumpHrcClient`/`EventPumpOptions`/`EventPumpResult`;
`isRelevantToSession`/`sessionRefFromEvent`/`matchesCategory`/`matchesEventKind`;
`createTimelineWsHandler`/`TimelineWsData`/`TimelineWsDeps`;
`createDiagnosticsWsHandler`/`DiagnosticsWsData`/`DiagnosticsWsDeps`;
`createGatewayIosRoutes`/`...FetchHandler`/`...WsHandlers`/`...ServeConfig` + `WsData`.

The comments ("consumed by P2", "P5", "P3") describe **phase-internal** wiring during the
build-out, not external contracts. The only things a true external consumer needs are
`createGatewayIosModule` + its options/return type, `resolveConfig`/config constants, the
frozen `contracts.ts` DTOs (a wire contract the iOS app mirrors), and arguably `createLogger`.
Everything else is internal seam that leaked out during phased development.

Note the boundary is asymmetric: it is simultaneously **too wide** (pipeline internals
exported) and inconsistent — `session-generation.ts` (`resolveSessionGeneration`,
`SessionGenerationSelector`) and `timeline-history.ts` (`projectPastWindow`,
`getTimelineHistoryPage`, `parseHistoryQuery`, `TimelineHistoryClient`) are *not* exported
yet are arguably more "API-like" than some things that are. The fix is to align the export
set to actual usage, not to add more.

## Findings by mechanism (outside-in)

### B — Boundary

#### F1 — Narrow the fat `index.ts` export surface to the actual public contract
- Location: `src/index.ts:50-101`
- Technique: **[T07] align interface to actual usage** (narrow leaky export)
- Mechanism repaired: the module boundary advertises internal pipeline seams as public API;
  this freezes refactor freedom on reducer/pump/WS internals for no consumer benefit.
- Direction: **remove** (drop reducer/projector/pump/event-filter/WS-handler/route-builder
  re-exports; keep `createGatewayIosModule` + options/return, config surface, `createLogger`,
  and the `contracts.ts` DTO types).
- Preservation rung: behavior-preserving for runtime (main.ts/module.ts import siblings
  directly, not via index); tests import siblings directly too. The *only* observable change
  is the package's TS export map.
- Falsifiable signal: after removal, `bun run --filter gateway-ios typecheck`, `bun test`,
  and the global `build:ordered` all pass; `scripts/check-boundaries.ts` unaffected.
- Risk: **Med**
- API-impact: **public-surface** (it edits the advertised `exports`). Deferred even though
  in-repo consumers are zero, because the published package contract is observable to anyone
  outside the monorepo and to the iOS client toolchain.
- Effort: S
- Tests: existing tests cover it (they don't depend on index); add nothing.
- Contraindication: if any out-of-tree tool or a not-yet-landed branch imports
  `runEventPump`/reducer internals from the package root, this breaks them. M02
  Expand/Contract is **dropped** here only on the assumption of no consumers; if that
  assumption is wrong, stage it (deprecate-then-remove) instead.

### C — Seams & structure

#### F2 — De-duplicate the three copies of "sessionRef from event"
- Location: `src/event-filter.ts:18-20` (`sessionRefFromEvent`, canonical, exported);
  `src/event-reducer.ts:107-109` (private `sessionRefFromEvent`); `src/event-pump.ts:190`
  (inlined `${event.scopeRef}/lane:${event.laneRef}` in `isRelevantEvent`).
- Technique: **[T15] extract missing abstraction** (consolidate duplicated intent into the
  one canonical helper that already exists in `event-filter.ts`).
- Mechanism repaired: the canonical sessionRef format is encoded in three places. Worse,
  **they disagree**: `event-filter.ts` and `event-pump.ts` produce `"<scopeRef>/lane:<laneRef>"`
  (scopeRef already carries the `agent:` prefix, per the doc comment), while
  `event-reducer.ts:108` prepends an extra `agent:` -> `"agent:<scopeRef>/lane:<laneRef>"`.
- Direction: **relocate/centralize** — have reducer and pump call
  `event-filter.ts#sessionRefFromEvent`.
- Preservation rung: **NOT a pure refactor for the reducer.** The reducer's frame
  `sessionRef` field is part of the emitted `TimelineFrame` (a wire DTO). Switching it to the
  canonical form **changes observable output** if `scopeRef` already includes `agent:`
  (double-prefix today vs single after). That is a redesign / bug-fix, not behavior-preserving.
- Falsifiable signal: re-run `event-reducer.test.ts` and `frame-projector.test.ts` and inspect
  asserted `sessionRef` values; if they assert the double-`agent:` form, the current behavior
  is load-bearing and the discrepancy is a latent bug to fix deliberately, not silently dedup.
- Risk: **High** (output-shape change for the reducer arm)
- API-impact: **public-surface** (alters `TimelineFrame.sessionRef` content on the wire)
- Effort: S (mechanically) but requires a behavior decision + test review
- Contraindication: pump and filter agree and are safe to share immediately; the reducer copy
  is the divergent one and must be reconciled as an intentional fix. Do **not** fold all three
  blindly.

#### F3 — Remove the dead `reduceMessage` arm or reify it as an explicit no-op contract
- Location: `src/event-reducer.ts:654-662` (`reduceMessage` ignores `message` body/id/createdAt,
  only bumps `highWaterMessageSeq`, always returns `[{action:'noop'}]`)
- Technique: **[T16] collapse premature abstraction** (a message-reduction branch whose
  variation never materialized — it produces no frames)
- Mechanism repaired: `ReducerInput`'s `'message'` variant and the whole message plumbing
  (projector merges messages, history collects them, pump streams them) imply messages affect
  frames, but the reducer never turns a message into a frame. This is structure built for a
  capability that doesn't exist yet.
- Direction: **remove / honestly mark** — either delete the message arm and tighten
  `ReducerInput` to events-only, or keep it but document it as a deliberate high-water-only
  sink so the next reader doesn't assume frames are produced.
- Preservation rung: keeping high-water bump = behavior-preserving; deleting the `'message'`
  variant of `ReducerInput` would ripple to projector/history/pump (those still need to *carry*
  messages even if they produce nothing) — so a full removal is **not** local and likely
  changes the `ReducerInput` public type.
- Falsifiable signal: grep for any test asserting a frame is produced from a `kind:'message'`
  input — there is none; `event-reducer.test.ts` only feeds events.
- Risk: **Low** (documenting) / **Med** (if narrowing the `ReducerInput` type, which is exported)
- API-impact: internal-only for the doc/no-op clarification; **public-surface** if you narrow
  `ReducerInput`.
- Effort: S
- Contraindication: this is plausibly **load-bearing scaffolding** for forthcoming durable-
  message rendering. Prefer the documenting variant over deletion unless product confirms
  messages will never become frames.

#### F4 — De-abstract the `createWsProxy` getter-proxy, or hoist its repetition
- Location: `src/routes.ts:25-40` (`createWsProxy`) and its six call sites at
  `routes.ts:258,261,273,276,285,288` (open/message/close × timeline/diagnostics)
- Technique: **[T23] remove middle man / [T22] guard clauses** — the open/message/close
  handlers each repeat the identical `if (route==='timeline' && ws.data.timeline) {proxy...}
  else if (route==='diagnostics' && ...)` shape three times.
- Mechanism repaired: the route-dispatch branch is copy-pasted across three WS lifecycle
  callbacks; a fourth route would require editing three arms. The proxy itself is a real seam
  (it avoids mutating `ws.data`) so it should stay, but the dispatch can be a single
  `selectHandler(ws.data)` lookup returning `{handler, data}`.
- Direction: **relocate** dispatch into one helper (`resolveRouteHandler(ws.data) ->
  {handler, data} | undefined`) consumed by all three callbacks.
- Preservation rung: behavior-preserving — same proxy, same handler calls, same unknown-route
  `close(1008)` path; pure internal restructuring inside `createGatewayIosWsHandlers`.
- Falsifiable signal: `routes` WS tests (4 in `routes`-touching tests) still pass; manual SMOKE
  WS connect still upgrades both routes.
- Risk: **Low**
- API-impact: **internal-only**
- Effort: S
- Contraindication: none; keep `createWsProxy` (deliberate seam — do not inline it).

#### F5 — Collapse the duplicated `parseUpgrade` query-parsing across the two WS handlers
- Location: `src/timeline-ws.ts:80-103` and `src/diagnostics-ws.ts:96-119` — identical
  parsing of `sessionRef`/`hostSessionId`/`generation`/`fromHrcSeq` (timeline adds
  `fromMessageSeq`/`raw`; diagnostics adds `category`/`eventKind`).
- Technique: **[T15] extract missing abstraction** (shared "parse common WS selector" helper)
- Mechanism repaired: the sessionRef/host/generation/fromHrcSeq parsing (incl. the subtle
  `Number.isFinite(generation) ? generation : undefined` and `.trim() || undefined` idioms)
  is duplicated; a parsing fix must be made twice.
- Direction: **extract** a small `parseCommonWsSelector(url)` returning the shared fields, then
  each handler spreads it and adds its own params.
- Preservation rung: behavior-preserving if the extracted helper reproduces the exact field set
  and the exact `Number.isFinite`/trim semantics. **Preservation rung: identical field set + same
  null/finite handling** — must not change which params become `undefined`.
- Falsifiable signal: `timeline-ws.test.ts` and `diagnostics-ws.test.ts` parse-upgrade cases
  pass unchanged.
- Risk: **Low**
- API-impact: **internal-only** (helper lives in the package; `parseUpgrade` signatures unchanged)
- Effort: S
- Contraindication: keep the per-handler extra params local; only the common core is shared.

### D — Invariants / E — Quality

#### F6 — `InputRequest.enter` contract says required, parser treats it optional
- Location: `src/contracts.ts:233-239` (`enter: boolean` — required) vs
  `src/input.ts:108-116` (`if (enter !== undefined ...)` then `enter: enter === true`)
- Technique: **[T07] align interface to actual usage** (tighten the leaky contract to match the
  tolerant parser, or vice-versa)
- Mechanism repaired: the frozen DTO claims `enter` is mandatory; the request parser silently
  defaults missing `enter` to `false`. A client trusting the contract and a client trusting the
  server behavior disagree.
- Direction: **isolate the decision** — either make `enter?: boolean` in `contracts.ts` (honest
  about the default) or reject missing `enter` in the parser. Behavior today = lenient.
- Preservation rung: making the contract `enter?: boolean` is behavior-preserving (matches the
  lenient parser) and is the lower-risk direction; tightening the parser would reject previously
  accepted requests (behavior change).
- Falsifiable signal: `input.test.ts` cases that omit `enter` still pass if you relax the type;
  they would start failing only if you tighten the parser.
- Risk: **Med** (it edits the frozen `contracts.ts`)
- API-impact: **public-surface** (wire DTO; iOS app mirrors this type)
- Effort: S
- Contraindication: `contracts.ts` is explicitly marked FROZEN — any change here must be
  coordinated, hence deferred.

#### F7 — `module.ts` re-hardcodes host/port/gatewayId defaults instead of reusing config constants
- Location: `src/module.ts:32-34` (`'127.0.0.1'`, `18480`, `'ios-local'`) vs
  `src/config.ts:5-7` (`DEFAULT_HOST`, `DEFAULT_PORT`, `DEFAULT_GATEWAY_ID`)
- Technique: **[T15] extract missing abstraction** (single source of truth for defaults — the
  constants already exist in `config.ts`)
- Mechanism repaired: the same three default literals live in two files; they happen to match
  today, but nothing enforces it. A change to `DEFAULT_PORT` would silently not apply to the
  module's `options.port ?? 18480` fallback.
- Direction: **relocate** — `module.ts` imports `DEFAULT_HOST`/`DEFAULT_PORT`/`DEFAULT_GATEWAY_ID`
  from `config.js` for its `??` fallbacks.
- Preservation rung: behavior-preserving (values are identical today); pure internal wiring.
- Falsifiable signal: typecheck + start the module with no host/port options and confirm it
  still binds `127.0.0.1:18480`.
- Risk: **Low**
- API-impact: **internal-only**
- Effort: S
- Contraindication: none.

#### F8 — Duplicated session-resolution logic: `module.ts` inline resolver vs `session-generation.ts`
- Location: `src/module.ts:55-73` (inline `resolveSession` that filters
  `sessionIndex.handleListSessions` candidates, prefers active, sorts by generation) vs
  `src/session-generation.ts:30-85` (`resolveSessionGeneration` / `pickActiveLatest` — same
  "active-first, highest-generation, host-pinned" intent against `client.listSessions`)
- Technique: **[T15] extract missing abstraction / [T03] relocate by affinity** (two
  implementations of "resolve a sessionRef to a concrete host/generation" with the same
  selection rule)
- Mechanism repaired: the "absent hostSessionId => active/latest for this sessionRef only"
  invariant (called out in route comments and the MEMORY note about generation selection) is
  implemented twice over two different data sources (mobile summaries vs raw HRC records).
- Direction: **relocate/consolidate** the selection rule into one helper so both paths share
  the active-first/highest-generation ordering.
- Preservation rung: **not a clean local refactor** — the two operate on different types
  (`MobileSessionSummary[]` with `status==='active'` vs `HrcSessionRecord[]` with
  `status==='active'`) and the module path additionally filters by `sessionRef` equality on the
  merged summary. Unifying requires a shared comparator + careful preservation of the exact
  predicate set and tie-breaking (module sorts by `generation` only; session-generation sorts by
  `generation` then `updatedAt`). These tie-breaks differ, so a naive merge changes selection.
- Falsifiable signal: construct two same-generation candidates differing only in `updatedAt`;
  module path is order-undefined, session-generation path picks newer `updatedAt`. A unified
  helper must preserve whichever each call site relied on.
- Risk: **High** (selection-order behavior change risk; affects which generation a mobile WS
  attaches to)
- API-impact: **internal-only** in type, but **behavior-affecting** for live session routing
- Effort: M
- Contraindication: the differing tie-break is likely **load-bearing**; treat as a deliberate
  redesign with tests, not an auto-dedup.

#### F9 — `getTimelineHistoryPage` discards parsed `raw` (`void query.raw`)
- Location: `src/timeline-history.ts:322-327` (`void query.raw`) and `parseHistoryQuery` parses
  `raw` at `:118`
- Technique: **[T16] collapse premature abstraction** (a parsed query field that no code path
  consumes)
- Mechanism repaired: `raw` is validated and parsed for `GET /v1/history` then explicitly thrown
  away — premature plumbing for a raw-history mode that doesn't exist. The `void` is a tell.
- Direction: **remove** `raw` from `parseHistoryQuery`/`ParsedHistoryQuery` (and the `void`), OR
  implement raw history. Removal is the behavior-preserving cleanup.
- Preservation rung: behavior-preserving — `raw` currently affects nothing; dropping it changes
  no response. (Note: it would mean `GET /v1/history?raw=garbage` no longer 400s on the `raw`
  validation — a minor validation surface reduction; confirm no test asserts that 400.)
- Falsifiable signal: search `timeline-history.test.ts` for a `raw`-validation assertion; if
  none, removal is safe.
- Risk: **Low**
- API-impact: **internal-only** (query param is undocumented in the exported contracts; not in
  `contracts.ts`)
- Effort: S
- Contraindication: if a raw-history feature is imminent, leave the parse in and just drop the
  `void` once it's wired.

## Deliberately left alone (where-NOT)

- **event-pump.ts two-cursor buffering / phase machine** (`buffering -> draining -> live`,
  lines 162-377). This is the highest-stakes concurrency code and it is carefully correct:
  pumps start before snapshot, buffer, then drain strictly-newer items. The shared-mutable
  state (`hrcHighWater`, buffers, `phase`) is confined to a single async scope with cooperative
  (single-threaded event-loop) access — **T31/T32 do not apply** (no true parallel mutation, no
  check-then-act race across threads). Refactoring this for "immutability" would add risk with
  zero correctness gain. The `eventBuffer`/`messageBuffer` are intentionally cleared after
  drain. Leave as-is.
- **`createWsProxy`** (routes.ts:25): a deliberate substitution seam to avoid mutating
  `ws.data`; do NOT inline (only its dispatch repetition, F4, is worth touching).
- **Reducer dispatch `switch` (event-reducer.ts:602-647)**: a clean type-dispatch, one arm per
  category, with a `default: noop`. This is the *good* end-state of T19, not a candidate for
  further change. The per-category `XxxKey` builders and the `upsertFrame` consolidation are
  already the extracted abstraction — do not re-abstract.
- **Typed payload guards (event-reducer.ts:217-245)**: `isToolCallPayload` etc. guard on string
  literals; do NOT attempt to dedup them by parameterizing the `typeof`/literal — that risks the
  biome `useValidTypeof`/over-generic-guard trap and loses the precise discriminators.
- **logger.ts level gate** (`ACP_IOS_LOG_LEVEL`): tiny, matches gateway-discord's pattern;
  fine.
- **`contracts.ts` DTO shapes**: frozen wire contract mirrored by the iOS client. Only F6
  (the `enter` mismatch) is worth raising, and only as a coordinated public-surface change.
- **`session-generation.ts` / `timeline-history.ts` not being in index.ts**: correct — these
  are internal. Do not "fix" by exporting them.

## If applying — outside-in sequence

1. **F4** (WS dispatch helper) and **F5** (shared WS selector parse) — internal-only,
   Low-risk, covered by existing WS tests. Apply first; they shrink the surface area before
   touching the boundary.
2. **F7** (module reuses config default constants) and **F9** (drop dead `raw` plumbing) —
   internal-only, Low-risk.
3. **F3** (document/no-op the message arm) in its Low-risk documenting form.
4. Re-run `bun run --filter gateway-ios typecheck && bun run --filter gateway-ios test`.
5. **Defer to human review:** F1 (narrow index — public-surface), F2 (reducer sessionRef
   double-prefix — High/output change), F6 (frozen `contracts.ts` `enter`), F8 (session
   resolver tie-break unification — High/behavior).

## Safety checklist

- [ ] `bun run --filter gateway-ios typecheck` clean
- [ ] `bun run --filter gateway-ios test` green (all 11 test files)
- [ ] Global `bun run build:ordered` still builds `gateway-ios` and downstream `acp-server`
- [ ] `scripts/check-boundaries.ts` passes (no new cross-layer imports introduced by F2/F8)
- [ ] No applied change touches `src/contracts.ts` (frozen) — F6 stays deferred
- [ ] No applied change alters emitted `TimelineFrame` field values — F2 stays deferred
- [ ] Manual SMOKE.md WS connect: `/v1/timeline` and `/v1/diagnostics/events` both upgrade
      and stream after F4/F5
- [ ] For F1: confirm no out-of-tree consumer imports reducer/pump/WS internals from the
      package root before removing them from `index.ts`
