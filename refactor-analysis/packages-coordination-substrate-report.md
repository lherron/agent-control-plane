# Refactor Analysis — `packages/coordination-substrate`

ANALYSIS ONLY. No source files were modified. This report inventories SOLID violations and code smells with `file:line` locations, impact, risk, and effort to guide a downstream apply stage.

## Scope

- Source root: `packages/coordination-substrate/src`
- TS source files analyzed: 22 (0 test files present)
- Total source lines: ~1510
- Largest / central files read in full:
  - `commands/append-event.ts` (327) — the write path, far and away the densest file
  - `storage/records.ts` (272) — row types + hydrators + getters
  - `queries/timeline.ts` (113), `storage/open-store.ts` (111), `queries/links.ts` (101)
  - all 7 mutation command files, all query files, all util files

Overall this is a clean, small, well-factored package. There are no fat interfaces, no inheritance/LSP issues, no DIP god-objects (the `Database` is threaded in as a parameter, which is good). The findings are dominated by **duplication** across the near-identical state-transition commands and the repeated SQL column lists / hydration mapping.

## Scorecard

| Dimension | Grade | Notes |
|---|---|---|
| SRP | B | `append-event.ts:appendEvent` mixes 3 inserts + result assembly in one 250-line function; `records.ts` mixes row-types, hydrators, and getters |
| OCP | A- | No type-keyed switch chains; column lists are hand-maintained and must be edited in lockstep, a mild OCP smell |
| LSP | A | No subclassing / overrides; nothing to violate |
| ISP | A | No interface exceeds a handful of members |
| DIP | A | `Database`/`CoordinationStore` passed as parameters; no hidden `new Concrete()` collaborators in logic paths |
| DRY | C | Six state-transition commands are structurally identical; SQL column lists duplicated 3x; hydrator/binder mapping duplicated |
| Function size | C+ | `appendEvent` is ~250 lines / deep nesting |
| Magic values / primitives | B- | State strings (`'open'`, `'queued'`, `'leased'`…) and the `'~'` session-ref delimiter are bare literals scattered across files |

## Priority Refactorings

### P1 — Extract row→domain INSERT helpers out of `appendEvent`
- **Location:** `commands/append-event.ts:92-326` (the transaction body; `appendEvent` function spans lines 74-327)
- **Principle/smell:** SRP, Long Method, deep nesting (4+ in the participant/recipient loops inside the transaction inside the conditional blocks)
- **Impact:** The single function performs: project-id assertion, idempotency lookup, sequence allocation, ULID minting, event insert, links insert, participant fan-out insert, conditional handoff insert + domain object build, conditional wake insert + domain object build, dispatch-attempt fan-out, and final result assembly. It is the hardest file in the package to read or test in isolation.
- **Fix shape:** Extract `insertEvent`, `insertEventLinks`, `insertParticipants`, `insertHandoff`, `insertWake`, `insertDispatchAttempts` private helpers that each take `(sqlite, ...)` and return the built domain fragment. `appendEvent` becomes orchestration only.
- **Risk:** Medium — pure mechanical extraction, but the inserts share the `now`/`eventId`/`seq` locals and run inside one transaction; extraction must preserve ordering and the transaction boundary. Not behavior-preserving-guaranteed by the narrow definition (touches dependency wiring / call structure), so flagged `behaviorPreserving=false`.
- **Effort:** M

### P2 — Collapse the six near-identical state-transition commands
- **Location:** `commands/accept-handoff.ts`, `commands/complete-handoff.ts`, `commands/cancel-handoff.ts` (each ~29 lines), `commands/lease-wake.ts:10-28`, `commands/consume-wake.ts`, `commands/cancel-wake.ts`
- **Principle/smell:** DRY / copy-paste duplication
- **Impact:** All six follow the identical template: open transaction → `getXById` → guard on allowed source states (return `undefined`) → `UPDATE ... SET state=?, updated_at=? WHERE id=?` → re-read and return. The three handoff commands differ only in (target state, allowed-from states, timestamp field name). The three wake commands additionally null `leased_until`. Any change to the transition protocol (e.g. add an audit column) must be applied in six places.
- **Fix shape:** A `transitionHandoff(store, {handoffId, to, allowedFrom, at})` and `transitionWake(...)` helper, with the public commands becoming thin wrappers binding the constant arguments. Keeps the public API intact.
- **Risk:** Medium — changes call structure / shared error semantics across the wake-vs-handoff null-leased_until difference; flagged `behaviorPreserving=false`.
- **Effort:** M

### P3 — Centralize duplicated SQL column lists and row→domain mapping
- **Location:** event column list duplicated at `storage/records.ts:178-202` (`getJoinedEventRow`) and `queries/timeline.ts:74-100` (`listEvents`); the links row→record mapping at `queries/links.ts:89-100` re-implements the link half of `hydrateCoordinationEvent` (`storage/records.ts:102-109`); `CoordinationEventLinkRow` is declared twice (`storage/records.ts:30-40` and `queries/links.ts:19-30`).
- **Principle/smell:** DRY, OCP (adding a column forces synchronized edits in 3-4 places), primitive obsession on column-name strings
- **Impact:** Schema drift hazard — a new event/link column must be added to two SELECT lists and one hydrator with no compiler help if any is missed.
- **Fix shape:** Export a single `EVENT_JOIN_COLUMNS` SQL fragment constant and reuse the existing `hydrateCoordinationEvent` from `timeline.ts` (it already does), and dedupe the `CoordinationEventLinkRow` type into one exported declaration consumed by both files.
- **Risk:** Low–Medium — the column-list constant is a pure extraction (same string), but unifying the two `CoordinationEventLinkRow` types crosses module boundaries; flagged `behaviorPreserving=false` for the type unification, `true` is reasonable only for the literal column-list constant.
- **Effort:** S–M

### P4 — Name the magic state-string and delimiter literals
- **Location:** state literals throughout commands (e.g. `append-event.ts:59,63,67,71`; guards/updates in all six transition commands); session-ref delimiter `'~'` at `util/session-ref.ts:29,33,42` and `queries/*` via `formatCanonicalSessionRef`
- **Principle/smell:** Magic strings / primitive obsession
- **Impact:** `'open'`, `'accepted'`, `'completed'`, `'cancelled'`, `'queued'`, `'leased'`, `'consumed'` and the `'~'` delimiter are bare literals; a typo compiles silently. The domain types already constrain `Handoff['state']` / `WakeRequest['state']`, so const objects would be cheap.
- **Fix shape:** `const HANDOFF_STATE = { open:'open', ... } as const` and `const WAKE_STATE = {...}`; a `SESSION_REF_DELIMITER = '~'` constant in `session-ref.ts`. Replace literals with the same-valued named constants.
- **Risk:** Low — replacing a literal with a named const of the identical value is behavior-preserving.
- **Effort:** S

## Code Smells

| # | Location | Smell | Severity | Behavior-preserving fix? |
|---|---|---|---|---|
| 1 | `commands/append-event.ts:74-327` | Long Method (~250 lines) / SRP | High | No (P1) |
| 2 | `commands/append-event.ts:161-165,277-302` | Nested loop-inside-conditional-inside-transaction (depth 4) | Med | No (P1) |
| 3 | `commands/{accept,complete,cancel}-handoff.ts` + `{lease,consume,cancel}-wake.ts` | Duplicated transition template (6x) | High | No (P2) |
| 4 | `records.ts:178-202` vs `timeline.ts:74-100` | Duplicated SELECT column list | Med | Const extraction: Yes; broader: No |
| 5 | `records.ts:30-40` & `links.ts:19-30` | `CoordinationEventLinkRow` declared twice | Med | No (cross-module type unify) |
| 6 | `links.ts:89-100` vs `records.ts:102-109` | Re-implemented link row→domain mapping | Med | No |
| 7 | commands + `session-ref.ts` | Magic state strings + `'~'` delimiter | Med | Yes (P4) |
| 8 | `records.ts:165`, `records.ts:95` | `JSON.parse(...) as ParticipantRef` used directly instead of the `parseJson` helper used everywhere else (inconsistency); also non-null assumption | Low | Yes (swap to existing helper where value is non-null-guaranteed — but null-handling differs, so verify) |
| 9 | `queries/wakes.ts:13-44` | Two near-identical SELECT branches differing only by the `session_ref` predicate | Low | No (conditional-predicate build like `timeline.ts` would change SQL) |
| 10 | `records.ts:1-272` | File mixes row types + hydrators + getters (3 concerns) | Low | Splitting = No |
| 11 | `util/ulid.ts:9,25,33` magic `10`/`16`/`32`/`5n` | Magic numbers (ULID field widths) | Low | Yes (named consts, same values) |
| 12 | `open-store.ts:62-64` | PRAGMA strings + `busy_timeout=5000` magic | Low | Yes (named const, same value) |

## Quick Wins (low risk, behavior-preserving)

- **QW1 — Named state constants (P4):** replace the seven handoff/wake state string literals with `as const` lookup objects of identical values. `behaviorPreserving=true`.
- **QW2 — `SESSION_REF_DELIMITER = '~'` constant** in `util/session-ref.ts` replacing the three `'~'` literals. `behaviorPreserving=true`.
- **QW3 — Name ULID magic numbers** (`TIME_CHARS=10`, `RANDOM_CHARS=16`, `ENCODING.length` instead of `32`, shift `5n`) in `util/ulid.ts`. `behaviorPreserving=true`.
- **QW4 — Name `busy_timeout` / journal pragmas** in `open-store.ts`. `behaviorPreserving=true`.
- **QW5 — Extract `EVENT_JOIN_COLUMNS` SQL fragment constant** shared by `records.ts:getJoinedEventRow` and `timeline.ts:listEvents` (identical column list). The literal-string extraction alone is `behaviorPreserving=true`.

## Tech Debt (larger, deferred)

- **TD1:** `appendEvent` decomposition (P1) — biggest readability/testability win, needs care with the transaction boundary.
- **TD2:** Unify the six transition commands behind two generic helpers (P2).
- **TD3:** Single source of truth for the event/link row shape and its hydration (P3 + smell 5/6) — eliminates the schema-drift hazard. This is the highest-leverage correctness-of-maintenance item.

## Safety Checklist (for the apply stage)

- [ ] Run the package build/typecheck after each change (no tests exist in-package — `find` shows 0 `*.test.ts`; rely on `tsc` + any repo-level integration tests).
- [ ] For P1: preserve insert ordering (events → links → participants → handoff → wake → dispatch attempts) and keep everything inside the single `store.sqlite.transaction(...)` call.
- [ ] For P2: preserve the wake-only `leased_until = NULL` clearing and the distinct allowed-from state sets per command; verify the `undefined` return on guard failure is unchanged.
- [ ] For P3 type unification: confirm both `CoordinationEventLinkRow` declarations are byte-identical before merging; they currently differ (the `links.ts` copy adds a `seq` column).
- [ ] Magic-constant swaps must use the EXACT same value (state strings, `'~'`, `5000`, ULID widths).
- [ ] No public export signatures in `index.ts` should change for quick wins; P1/P2 may add internal helpers but must keep `appendEvent`/the six command signatures stable.
