# Refactor Analysis — `packages/acp-server`

ANALYSIS ONLY. No source was modified. This report catalogs SOLID violations and
code smells with locations, impact, risk, and effort. Apply-stage hints
(`behaviorPreserving`) are carried in the structured return, not here.

## Scope

- Source files analyzed (non-test): 85 `*.ts` files under `src/`
- Total non-test source lines: **19,377**
- Largest / most central files read in full:
  - `handlers/mobile.ts` — 1,719
  - `real-launcher.ts` — 1,224
  - `input-admission/input-admission-service.ts` — 1,154
  - `cli.ts` — 753
  - `jobs/flow-engine.ts` — 606
  - `integration/input-queue-dispatcher.ts` — 606
  - `integration/interface-run-dispatcher.ts` — 570
  - `deps.ts` — 233

## Scorecard

| Dimension | Grade | Notes |
|-----------|-------|-------|
| SRP | C- | Several files mix projection + parsing + validation + HTTP + WS + DB access (`mobile.ts`, `real-launcher.ts`). Functions routinely exceed 50 lines. |
| OCP | C | Type/kind-keyed `switch`/`if` chains for event kinds, intent kinds, statuses scattered rather than table-driven. |
| LSP | A- | No abusive subclassing or not-implemented overrides observed; mostly functional + interface-typed deps. |
| ISP | B- | `AcpServerDeps`/`ResolvedAcpServerDeps` are wide (~30 members) and threaded everywhere; consumers use `Pick<>` (good) but the root interface is a god-config. |
| DIP | B | Mostly inverted via `deps` injection and factory functions. Weak spot: direct `new Database(...)` SQLite access embedded in `real-launcher.ts` / `interface-run-dispatcher.ts`. |
| DRY | C- | `isRecord`/`asRecord`/`readString` redefined in ~13 files; `runtime_busy` classifier duplicated; dispatcher start/stop/scheduleNext loop boilerplate triplicated; `${scopeRef}/lane:${laneRef}` formatting open-coded in 7+ files. |
| Testability | B | Pure helpers are well-isolated and a `__testing` export exists; the large multi-branch reconcilers are hard to unit-test in isolation. |

## Priority Refactorings

### P1 — Extract duplicated `isRecord` / `asRecord` / `readString` JSON guards into a shared module
- **Location:** `real-launcher.ts:1215`, `integration/interface-run-dispatcher.ts:551,555`, `handlers/mobile.ts:618,622`, `launch-role-scoped.ts:275`, `wrkf/participant-launch.ts:417,446`, `integration/wrkf-effect-reconciler.ts:61`, `delivery/interface-response-capture.ts:208`, `delivery/visible-assistant-messages.ts:199`, `handlers/runs-outbound-attachments.ts:278`, `handlers/ops-dashboard-shared.ts:34`, `handlers/workflow-tasks.ts:59`, `handlers/admin-contributions-reconcile.ts:21` (plus `parsers/body.ts:3` already exports one)
- **Smell:** Duplication (DRY). ~13 near-identical definitions of the same unknown-narrowing guards.
- **Impact:** High footprint, low individual risk. Divergence risk (some `readString` trim, some do not).
- **Risk:** Low — pure functions. **Effort:** Medium (touch many files / re-import).

### P2 — `handlers/mobile.ts` (1,719 lines) violates SRP; split projection / parsing / WS transport
- **Location:** `handlers/mobile.ts` whole file
- **Smell:** SRP. One module owns: DTO type definitions (`MobileSessionSummary`, `MobileTimelineFrame`, …), session/event/message *projection* (`projectSession`, `projectEvent`, `projectFrame`, `projectPrimaryEvent`, `projectMessage`), request *parsing/validation* (`parseMobileMessageFilter`, `parseMobileMessageAddress`, `readPositiveInteger`), dashboard snapshot assembly, and WebSocket pump lifecycle (`openMobileWebSocket`, `openMobileDashboardWebSocket`).
- **Impact:** High — central, change-prone surface. Hard to test projection without dragging in WS plumbing.
- **Risk:** Medium — large move; signatures cross boundaries. **Effort:** High.

### P3 — `openMobileWebSocket` is a ~160-line multi-mode method with deep nesting
- **Location:** `handlers/mobile.ts:1539-1696`
- **Smell:** Long method + OCP. Branches on `kind` (`messages` / `dashboard` / `timeline` / `diagnostics`) inline, each with its own setup; nesting reaches 4+ inside the timeline + pump blocks.
- **Impact:** High cognitive load; adding a new stream kind means editing this monolith.
- **Risk:** Medium — async ordering and abort semantics must be preserved. **Effort:** Medium-High.

### P4 — `real-launcher.ts` mixes launch orchestration with raw SQLite reads
- **Location:** `real-launcher.ts` — `createRealLauncher` closure (`:49-291`) plus `findLaunchIdForRun:294`, `findLatestLaunchId:315`, `findLiveTmuxRuntimeForSessionRef:717`, `readLatestAssistantMessageSeq:759`, `readAssistantMessageAfterSeq:806`, `readCompletedAssistantMessageAfterSeq:842`, `readCompletedAssistantMessageFromHrcEvents:954`, `readRunStatus:664`, `hasHrcAcceptedRunSince:639`, `listLegacyRawRunEvents:696`
- **Smell:** SRP + DIP. The launcher embeds ~10 `new Database(hrcDbPath, { readonly: true })` query functions. These are an HRC read-repository concern bolted onto the launcher.
- **Impact:** High — `interface-run-dispatcher.ts` already imports four of these readers across module boundaries, signalling the repository wants to be its own unit.
- **Risk:** Medium — pure-ish reads, but it is a public surface other modules import. **Effort:** High.

### P5 — `createRealLauncher` return-closure is a ~245-line function with three near-duplicate launch tails
- **Location:** `real-launcher.ts:49-291`
- **Smell:** Long method + duplication. The no-prompt branch, the tmux-runtime branch, and the dispatchTurn branch each repeat the `resolveSession{create:true}` + `updateAcpRun(...)` + return-shape construction. Comment blocks duplicated verbatim at `:69-95` and `:113-125`.
- **Impact:** High — the hardest-to-follow code in the package; the cold-launch invariant lives here (per project memory).
- **Risk:** High — dispatch/await ordering and run-store side effects are load-bearing. **Effort:** High.

### P6 — `interface-run-dispatcher.reconcileRun` long method + repeated stale/fail blocks
- **Location:** `integration/interface-run-dispatcher.ts:74-270`
- **Smell:** Long method (~196 lines), deep nesting (>=4), duplication of the `runFailed/errorCode/errorMessage + handleFailureOrSkip` pattern across five branches, repeated `isStale(...)` + `turn_timeout` message construction.
- **Impact:** High — core delivery reconciliation; correctness-critical.
- **Risk:** Medium-High — control flow + error mapping must be preserved exactly. **Effort:** Medium.

### P7 — Dispatcher start/stop/scheduleNext loop boilerplate triplicated
- **Location:** `integration/interface-run-dispatcher.ts:336-394`, `integration/input-queue-dispatcher.ts:533-600`, `integration/wake-dispatcher.ts`
- **Smell:** Duplication. The `running` flag + `inflight` promise + `scheduleNext`/`setTimeout` + catch-log-then-reschedule machinery is copy-pasted across three dispatchers.
- **Impact:** Medium — bugs (e.g. unguarded reschedule) must be fixed in three places.
- **Risk:** Low-Medium — extract a `createPollingLoop({ intervalMs, runOnce })` helper. **Effort:** Medium.

### P8 — `runtime_busy` and contribution-error classifiers duplicated
- **Location:** `input-admission/input-admission-service.ts:224-232` (`runtimeBusyError`) vs `integration/input-queue-dispatcher.ts:42-50` (`isRuntimeBusyError`) — byte-identical logic; also `classifyContributionDeliveryError` family at `input-admission-service.ts:256-286`
- **Smell:** Duplication + primitive obsession (error shape probed via stringly-typed `code`/`errorCode`/message-substring).
- **Impact:** Medium — error-classification drift between admission and dispatch paths.
- **Risk:** Low — pure predicate. **Effort:** Low.

### P9 — `InputAdmissionService` is a god-class with five near-identical `create*Admission` builders
- **Location:** `input-admission/input-admission-service.ts:288-1137` — `createRejectedAdmission`, `createQueuedContributionFallback`, `createPendingContributionAdmission`, `createAcceptedContributionAdmission`, plus the inline builders in `admit()` and `admitControl()`
- **Smell:** SRP + duplication. Each builder repeats `inputAdmissionStore.create({...}) → recordInputAdmissionEvent({...}) → return {inputAttempt, admission, currentState, created}`. The replay-short-circuit block (`if (!attempt.created) {...}`) is copy-pasted three times (`:566`, `:759`, `:882`).
- **Impact:** High — 1,154-line class; the central admission state machine.
- **Risk:** Medium — event recording + store writes are side-effectful and ordered. **Effort:** High.

### P10 — `${scopeRef}/lane:${laneRef}` session-ref formatting open-coded across the package
- **Location:** `real-launcher.ts:1203` (`toHrcSessionRef`), `handlers/mobile.ts:236` (`sessionRef`), `input-admission-service.ts:355,788,859,937`, `integration/input-queue-dispatcher.ts:349`, `handlers/sessions-reset.ts`, `handlers/session-refs-events.ts`, `cli.ts`
- **Smell:** Duplication + primitive obsession. `hrc-core` already exports `formatCanonicalSessionRef` (used in `jobs/flow-engine.ts:451`); other sites hand-roll the template literal.
- **Impact:** Medium — format drift risk; one canonical formatter exists but is inconsistently used.
- **Risk:** Low — replace string interpolation with the existing helper. **Effort:** Low-Medium.

### P11 — `DEFAULT_INTERFACE_DB_PATH` / state-dir defaults hardcode an absolute user home path
- **Location:** `deps.ts:40-43`
- **Smell:** Magic value / configuration leak. `'/Users/lherron/praesidium/var/db/acp-interface.db'` (and two siblings) bakes a developer-specific absolute path into a shipped default.
- **Impact:** Medium — portability/security; only env-overridable for the interface DB, not the others.
- **Risk:** Medium — changing the default could alter where data is read/written (behavior change). **Effort:** Low.

## Code Smells

| # | Location | Smell | Severity | Notes |
|---|----------|-------|----------|-------|
| 1 | mobile.ts:1539 | Long method | High | `openMobileWebSocket` ~160 lines, 4-way `kind` switch |
| 2 | mobile.ts:826 | Long method + OCP | Med | `projectPrimaryEvent` 7-case `switch` on `eventKind` |
| 3 | mobile.ts:271 | Magic set | Low | `DEAD_RUNTIME_STATUSES` ok; status detection via `.includes()` substring matching (`mobileStatus:273`) is fragile |
| 4 | real-launcher.ts:49 | Long method | High | launcher closure ~245 lines, 3 duplicated tails |
| 5 | real-launcher.ts:1058 | Long fn / OCP | Med | `inferHarnessIntent` chained provider fallbacks; `readHarnessProviderFromPath:1138` path-substring sniffing |
| 6 | real-launcher.ts:842 | Long method | Med | `readCompletedAssistantMessageAfterSeq` ~85 lines w/ nested candidate map |
| 7 | input-admission-service.ts:853 | Long method | High | `admit()` ~285 lines |
| 8 | input-admission-service.ts:566,759,882 | Duplication | Med | replay short-circuit block copied 3x |
| 9 | input-queue-dispatcher.ts:394 | Long method + nesting | High | `dispatchItem` ~140 lines, head-reconcile `while` + try/catch |
| 10 | interface-run-dispatcher.ts:74 | Long method + nesting | High | `reconcileRun` ~196 lines |
| 11 | flow-engine.ts:50 | Long method | Med | `advanceJobFlow` ~73 lines orchestrating phases |
| 12 | flow-engine.ts:349 | OCP | Low | `resolveTerminalStepTransition` exec/agent branching by `kind` |
| 13 | many (13 files) | Duplication | High | `isRecord`/`asRecord`/`readString` redefined |
| 14 | 3 dispatchers | Duplication | Med | start/stop/scheduleNext loop boilerplate |
| 15 | deps.ts:124-171 | ISP / fat interface | Med | `AcpServerDeps` ~30 optional members (god-config) |
| 16 | deps.ts:40-43 | Magic / hardcoded path | Med | developer-specific absolute defaults |
| 17 | input-admission-service.ts:224 / input-queue-dispatcher.ts:42 | Duplication | Med | `runtimeBusyError` identical twice |
| 18 | 7+ files | Duplication | Med | `${scopeRef}/lane:${laneRef}` open-coded |
| 19 | input-admission-service.ts:1103 / input-queue-dispatcher.ts:504 | Magic number | Low | `2_000` ms runtime-busy backoff repeated, unnamed |
| 20 | mobile.ts:32-40 | Magic numbers | Low | dashboard limits are named consts (good) but `30_000` ping interval at `:1246` is inline |

## Quick Wins

- Extract `runtimeBusyError`/`isRuntimeBusyError` into one shared predicate (P8). Pure, identical, two call sites. behaviorPreserving.
- Name the repeated `2_000` runtime-busy backoff as a constant (`RUNTIME_BUSY_REQUEUE_DELAY_MS`) in both dispatch/admission sites. behaviorPreserving.
- Replace open-coded `${scopeRef}/lane:${laneRef}` with the existing `formatCanonicalSessionRef` from `hrc-core` (P10) — already imported in `flow-engine.ts`. behaviorPreserving where the helper's output is byte-identical to the literal.
- Consolidate `isRecord`/`asRecord`/`readString` into a `parsers/`-level shared module and re-import (P1). behaviorPreserving for the identical-bodied copies (watch the trim-vs-no-trim variants — those are NOT identical).

## Tech Debt

- **SQLite read-repository leak (P4):** `real-launcher.ts` is simultaneously the launch orchestrator and the de-facto HRC read repository. Other modules import its readers. This should become a named `HrcReadRepository` with the launcher depending on the interface (DIP). Larger architectural item.
- **Admission state machine (P9):** `InputAdmissionService` encodes a multi-outcome state machine through five hand-written builder methods with shared response/event/return scaffolding. A single `emitAdmission(kind, ...)` table would shrink it substantially and make the state set enumerable.
- **god-config deps (P15):** `AcpServerDeps` keeps accreting optional members. Consumers already narrow via `Pick<>`; consider grouping by capability (inputStores, hrc, jobs, interface) to make the seams explicit.
- **Status detection by substring (smell #3):** `mobileStatus` infers lifecycle state from `.toLowerCase().includes('stale'|'inactive'|...)`. Brittle to upstream label changes; should map known status enums.

## Safety Checklist (for the apply stage)

- Pure extractions (shared `isRecord`/`asRecord`/`readString`, the `runtimeBusyError` predicate, naming the `2_000` backoff and `30_000` ping constants) are behavior-preserving ONLY where the moved bodies are byte-identical. The `readString` copies diverge on trimming — do NOT merge those blindly.
- `formatCanonicalSessionRef` substitution is safe only if its output equals `${scopeRef}/lane:${laneRef}` for the laneRef values in play; verify there is no normalization difference before swapping. Treat as NOT behavior-preserving until confirmed.
- Any decomposition of `createRealLauncher` (P5), `openMobileWebSocket` (P3), `reconcileRun` (P6), `dispatchItem`, or `admit()`/the admission builders touches async ordering, store writes, and error mapping — treat all as NOT behavior-preserving and gate on the existing `__tests__` suite (18 test files) plus a live smoke via the `acp-server-ops` runbook.
- Changing `deps.ts` default paths (P11) alters where data is read/written — NOT behavior-preserving.
- Re-run `bun test` for the package and a cold-launch smoke (the cold-launch `resolveSession{create:true}` invariant in `real-launcher.ts:76,116` is load-bearing per project memory) after any structural change.
