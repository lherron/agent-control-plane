# Refactor Analysis — `packages/gateway-ios`

ANALYSIS ONLY. No source was modified. This report is the sole artifact.

## Scope

| File | Lines | Role |
|------|------:|------|
| event-reducer.ts | 690 | Pure HRC-event → timeline-frame reducer (largest, central) |
| event-pump.ts | 380 | Snapshot+live race-safe replay/buffer plumbing for WS |
| timeline-history.ts | 363 | History paging + `projectPastWindow` shared by REST/WS |
| routes.ts | 317 | REST route table + WS upgrade/dispatch |
| session-index.ts | 305 | `/v1/sessions` merge/filter service |
| input.ts | 304 | `/v1/input` + `/v1/interrupt` handlers |
| timeline-ws.ts | 301 | WS `/v1/timeline` handler |
| contracts.ts | 256 | Frozen DTO contracts |
| diagnostics-ws.ts | 231 | WS `/v1/diagnostics/events` handler |
| module.ts | 110 | Bun.serve lifecycle entry point |
| index.ts | 101 | Barrel exports |
| session-generation.ts | 85 | Active/latest generation resolver |
| health.ts | 74 | `/v1/health` |
| frame-projector.ts | 68 | Reducer driver wrapper |
| config.ts | 53 | Env config |
| logger.ts | 51 | Logger factory |
| event-filter.ts | 49 | Category/eventKind predicates |
| main.ts | 53 | Process bootstrap |
| types.ts | 18 | `ReducerInput` union |

Total source lines analyzed (non-test `*.ts` under `src/`): **4441**.

---

## Scorecard

| Dimension | Grade | Notes |
|-----------|-------|-------|
| SRP | B- | event-reducer.ts (690) and event-pump.ts (380) carry many concerns; both close to the file-size ceiling. |
| OCP | B | One large `switch` over `eventKind` in the reducer; mostly delegated to per-category fns so additions are localized, but still a type-keyed dispatch chain. |
| LSP | A- | No bad overrides; minimal-interface clients (`EventPumpHrcClient`) are honest subsets. |
| ISP | B+ | `EventPumpOptions` is a 12-member options bag (acceptable as config), no fat behavioral interfaces. |
| DIP | B+ | Most collaborators injected; `module.ts` hardcodes `new HrcClient(...)` (acceptable at composition root). |
| DRY | C+ | Triple-duplicated WS route dispatch in routes.ts; duplicated frameSeq-override block in timeline-ws.ts; near-identical pump async fns + buffer-drain loops in event-pump.ts. |
| Dead code | C+ | `reduceMessage` is a no-op stub; `buildSnapshot(replay)` always receives empty arrays; `_target`/`_exhaustive`/`allUpdates` partly vestigial. |
| Type hygiene | C | input.ts relies heavily on `as unknown as { ... }` escape hatches (primitive obsession / structural reach-through). |

Overall: **B-**. Solid, well-commented, test-covered module. The highest-value cleanups are dead-parameter removal, deduplication of the WS dispatch and frameSeq logic, and tightening the reducer's repeated boilerplate.

---

## Priority Refactorings

### P1 — Remove dead `buildSnapshot` replay parameter (event-pump.ts + both callers)
`runEventPump` declares `buildSnapshot: (replay: { events, messages }) => Promise<...>` but the orchestrator always calls it with `{ events: [], messages: [] }` (event-pump.ts:306-309), and both callers ignore the argument (`buildSnapshot(_replay)` in timeline-ws.ts:157 and diagnostics-ws.ts:138). The `replay` plumbing is misleading dead surface — the comment at event-pump.ts:307 even says "Replay data comes from the store, not the pump."
- Principle: Dead code / misleading interface.
- Impact: Medium (clarity of the core WS contract).
- Risk: Low — purely removing an always-empty argument and its parameter; but it is a public signature change across files, so NOT behavior-preserving by the strict definition.
- Effort: S.

### P2 — Deduplicate the WS route-dispatch block (routes.ts:252-291)
`open`, `message`, and `close` each repeat the same `route === 'timeline' ? proxy+handler : route === 'diagnostics' ? proxy+handler : ...` discriminator. Extract a `dispatch(ws, fn)` helper that builds the proxy once and routes to the right handler method, or a small `{timeline, diagnostics}` lookup keyed by `route`.
- Principle: DRY / OCP (adding a 3rd WS route currently means editing 3 blocks).
- Impact: Medium.
- Risk: Low-Medium — pure structural extraction, but it touches the live WS event wiring, so verify against the ws tests; classified NOT behavior-preserving out of caution.
- Effort: S-M.

### P3 — Extract the duplicated frameSeq-override + send loop (timeline-ws.ts:207-263)
`onEvent` and `onMessage` contain an identical block: reduce input → reassign `result.state` → for each create/update update, spread `...update.frame` with `frameSeq: frameSeqCounter++`, wrap in a `FrameMessage`, and `send`. Extract `emitFrameUpdates(input)`.
- Principle: DRY.
- Impact: Medium.
- Risk: Low — the two blocks are byte-identical apart from the input; extraction preserves ordering. Behavior-preserving IF the extracted helper is called in the same order with the same closure state.
- Effort: S.

### P4 — Collapse the two near-identical pump async functions (event-pump.ts:210-282)
`runEventPumpAsync` and `runMessagePumpAsync` differ only in (iterator factory, relevance predicate, high-water field, emit callback, buffer). They duplicate the try/abort/buffer-or-emit/finally skeleton. Parameterize a single `runPump<T>(...)` generic.
- Principle: DRY / SRP.
- Impact: Medium (this is the trickiest concurrency code in the package; one shared path is easier to reason about).
- Risk: Medium — async ordering and finally/`finishIfBothDone` semantics must be preserved exactly. NOT behavior-preserving.
- Effort: M.

### P5 — Split event-reducer.ts (690 lines) by responsibility
The file mixes: state types, key builders, payload type-guards + extractors, the `upsertFrame` engine, ~11 per-category reducers, and the dispatch switch. Move the typed-payload guards/extractors (event-reducer.ts:191-266) and the key builders (79-101) into sibling modules (`reducer-payloads.ts`, `reducer-keys.ts`). Leaves the reducer focused on dispatch+upsert.
- Principle: SRP / file-size ceiling.
- Impact: Medium-High (navigability of the central module).
- Risk: Low-Medium — moving pure functions across files; public `reduce`/`createReducerState` unchanged. Each individual move is behavior-preserving, but module restructuring is classified NOT behavior-preserving here (touches the barrel + import graph).
- Effort: M.

---

## Code Smells

| Location | Smell | Principle | Note |
|----------|-------|-----------|------|
| event-reducer.ts:647-655 | Dead/no-op function | Dead code | `reduceMessage` only bumps `highWaterMessageSeq` then returns `[{action:'noop'}]`; messages never produce frames. Either document as intentional or remove the body's frame plumbing. |
| event-reducer.ts:595-640 | Type-keyed switch chain | OCP | 11-arm `switch(event.eventKind)`. Tolerable (delegates out), but a `Record<eventKind, handler>` table would make additions data-driven. |
| event-reducer.ts:312-319, 386-405 | Nested ternary status derivation | Readability | `statusValue`/`statusText` computed via stacked ternaries; extract small lookup maps like the existing `SESSION_STATUS_TEXT`. |
| event-reducer.ts:340, 384, 413, 448, … | Magic sentinel `'no-run'` | Primitive obsession | Repeated literal `'no-run'` as a null-run sentinel; promote to a named const. |
| event-pump.ts:335-349 | Duplicated drain loops | DRY | event/message buffer-drain loops are structurally identical; fold with the relevance-emit helper. |
| timeline-ws.ts:215-218 & 251-254 | Duplicated frameSeq spread | DRY | See P3. |
| timeline-ws.ts:124,191 vs reducer | Parallel `frameSeqCounter` | Hidden coupling | WS maintains its own `frameSeqCounter` AND seeds `reducerState.nextFrameSeq`; two counters tracking the same notion (timeline-ws.ts:124/191) invite drift. |
| routes.ts:25-40 | `as unknown as ServerWebSocket<T>` proxy | Type escape | `createWsProxy` casts through `unknown`; forwards only 4 props — fragile if Bun adds required WS methods used by handlers. |
| input.ts:152-215 | `as unknown as { … }` reach-through | Primitive obsession / type escape | `explicitMode`, `appSessionSelectorFor`, `latestRuntimeForSession` repeatedly cast resolved sessions/runtimes to ad-hoc inline shapes. Centralize these accessor shapes into named types. |
| session-index.ts:132 | Unused binding `_target` | Dead code | `targetByRef` is built (122-125) and looked up into `_target` but never consumed; both the map and lookup are dead. |
| session-index.ts:28,10-12 (history) | Magic numbers | Magic number | `CACHE_TTL_MS = 5_000` is named (good); but `DEFAULT_LIMIT=50`/`MAX_LIMIT=200`/`INITIAL_BEFORE_HRC_SEQ` in timeline-history.ts are fine — verify `SNAPSHOT_HISTORY_LIMIT=50` (timeline-ws.ts:52) and `DEFAULT_LIMIT=50` stay in sync. |
| session-index.ts:180-185, module.ts:65-68, input.ts:210-214 | Repeated sort-by-recency comparators | DRY | Three hand-rolled "latest wins" sorts (lastActivityAt / generation / updatedAt). Similar logic also in session-generation.ts:25-34. |
| module.ts:55-73 | Inline `resolveSession` duplicates session-generation.ts | DRY | The active/latest selection here re-implements `pickActiveLatest`/`resolveSessionGeneration` against MobileSessionSummary instead of HrcSessionRecord. |
| event-reducer.ts:683-686, reduce | Unreachable exhaustive throw | (benign) | `_exhaustive: never` default — correct pattern, keep. |
| frame-projector.ts:60-67 | `allUpdates` accumulated but rarely read | Possible dead field | `ProjectionResult.allUpdates` is populated on every call; `projectPastWindow` (timeline-history.ts:311) only destructures `{frames}`. Field is exported API so not safely removable. |
| diagnostics-ws.ts:145-175 | Large inline snapshot literal | Long expression | The fabricated `MobileSessionSummary` for diagnostics is a 30-line inline object; extract a `diagnosticsSnapshot(selected, fromHrcSeq)` builder. |

---

## Quick Wins (low risk, high clarity)

1. **Remove `_target` + `targetByRef`** in session-index.ts:122-132 — provably dead (built, looked up into an unused `_`-prefixed binding, never read). *Behavior-preserving.*
2. **Extract `'no-run'` sentinel** to a named const in event-reducer.ts. *Behavior-preserving.*
3. **Extract `emitFrameUpdates` helper** in timeline-ws.ts (P3) — collapses two identical blocks. *Behavior-preserving.*
4. **Replace nested status ternaries** (event-reducer.ts:312-319, 386-391) with small const lookup maps. *Behavior-preserving (same values).*
5. **Extract diagnostics snapshot builder** (diagnostics-ws.ts:145-175) — local function, identical output. *Behavior-preserving.*

---

## Tech Debt

- **`as unknown as` cluster in input.ts** (152-215) — the handler reaches into `ResolveSessionResponse`/`HrcRuntimeSnapshot` via inline structural casts because the upstream `hrc-core` types don't expose `mode`/`appSession`/`updatedAt` in the expected shape. Root-cause fix belongs in `hrc-core` contract alignment; until then, consolidate the accessor types in one place.
- **Two counters for frame sequence** (timeline-ws.ts `frameSeqCounter` vs reducer `nextFrameSeq`) — a latent drift bug surface; worth unifying so wire order and reducer order share one source of truth.
- **Snapshot-limit constants duplicated** across timeline-history.ts and timeline-ws.ts — centralize.
- **`reduceMessage` no-op** — durable hrcchat messages are watched, buffered, and routed through the reducer but produce zero frames. Either this is intentional (events are the timeline source of truth) and should be documented, or it is an unfinished feature path carrying cost in event-pump message plumbing.

---

## Safety Checklist (for the apply stage)

- [ ] Run the package test suite after every change: `event-reducer.test.ts`, `event-pump.test.ts`, `timeline-ws.test.ts`, `diagnostics-ws.test.ts`, `session-index.test.ts`, `timeline-history.test.ts`, `input.test.ts`, `contracts.test.ts`, `frame-projector.test.ts`, `health.test.ts` all live under `src/tests/`.
- [ ] P1 (buildSnapshot param) and P4 (pump merge) touch async ordering — confirm `event-pump.test.ts` race/buffer-drain cases still pass.
- [ ] P2 (WS dispatch) — confirm `timeline-ws.test.ts` and `diagnostics-ws.test.ts` open/message/close paths.
- [ ] contracts.ts is marked FROZEN — do NOT alter exported DTO shapes; treat any contract change as out of scope.
- [ ] frame-projector.ts `projectIncremental`/`allUpdates` are exported via index.ts:63 — do not remove without a barrel-export audit.
- [ ] Keep canonical `eventKind`/`category` strings intact (reducer file header warns: "NEVER rename eventKinds or invent new categories").
- [ ] Quick Wins 1-5 are behavior-preserving and can be applied/verified independently.
