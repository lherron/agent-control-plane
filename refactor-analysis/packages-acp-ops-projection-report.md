# Refactor Analysis — `packages/acp-ops-projection`

**Scope:** `src/index.ts` (935 lines, sole source file)
**Mode:** ANALYSIS ONLY (no source edits)
**Date:** 2026-06-07

This package projects raw `HrcLifecycleEvent`s into dashboard-facing
`DashboardEvent` / `SessionTimelineRow` / `SessionDashboardSummary` view models,
with payload redaction. It is a pure transform library (no I/O, no classes, no
DI) consumed by the ACP operator dashboard. Tests live under `test/`
(`projection.red.test.ts`, `input-admission-labels.test.ts`).

---

## Scorecard

| Dimension | Grade | Notes |
|---|---|---|
| SRP (file) | C | One 935-line module mixing 4 concerns: type contracts, event classification, row derivation, redaction. No internal module boundaries. |
| SRP (function) | B- | Most helpers are small & focused; two functions (`deriveSessionRow`, `deriveFamily`) are long. |
| OCP | C+ | Classification logic is a wall of `if`/`startsWith`/`includes` string-matching chains; adding a family/severity/status means editing the chain. |
| LSP | A | No inheritance, no overrides — N/A. |
| ISP | A- | Types are data DTOs, not behavioral interfaces; wide but appropriately so. |
| DIP | B+ | Pure functions; only ambient coupling is `process.env` read inside `redactionOptions`. |
| Naming / readability | A- | Clear, intention-revealing names throughout. |
| Magic numbers / primitive obsession | C | Many bare priority/limit numbers and stringly-typed status/family unions matched via substring. |
| Duplication | B- | Several near-identical `latestString`/scan-loop and substring-match patterns. |

**Overall: B-.** Healthy, well-named pure code, but everything lives in one file
and the classification core is substring-pattern soup that is fragile to extend.

---

## Priority Refactorings

### P1 — Split the module by concern (SRP, file-level)
**Location:** `src/index.ts:1-935` (whole file)
**Smell:** Single 935-line module with 4 distinct responsibilities:
1. Public type contracts (`:14-154`)
2. Event classification (`deriveFamily`/`deriveSeverity`/`eventLabel`/`eventShortDetail`, `:241-459`)
3. Row/summary derivation (`:548-935`)
4. Redaction (`:164-546`, `:888-902`)

**Impact:** High — harder to navigate, test in isolation, and reason about.
Co-location forces every consumer of one concern to pull the whole file.
**Risk to fix:** Medium — re-export from `index.ts` to preserve the public API
(`projectHrcToDashboardEvent`, `deriveSessionRow`, `redactPayload`, `buildSummary`,
all exported types). Pure move of declarations between files.
**Effort:** M
**behaviorPreserving:** false (file moves change module graph / import wiring;
re-exports must be exact — treat as structural, not pure).

### P2 — Replace `deriveFamily` if-chain with a table-driven classifier (OCP)
**Location:** `src/index.ts:241-302`
**Smell:** Long sequential `if` chain mixing `payloadType` equality, `startsWith`,
`includes`, and `category` checks to map an event to one of 9 families. Open to
modification, not extension; ordering is load-bearing and implicit.
**Impact:** Medium-High — every new event family edits the chain; ordering bugs
are easy (e.g. an error event that is also a tool event).
**Risk to fix:** Medium — extract ordered predicate→family rules into a list and
return the first match. Must preserve current short-circuit ordering exactly.
**Effort:** M
**behaviorPreserving:** false (re-expressing control flow as data; equivalent only
if ordering is preserved precisely — classify conservatively).

### P3 — `deriveSessionRow` is a long method (SRP / long method)
**Location:** `src/index.ts:811-886` (~75 lines)
**Smell:** Single function sorts, derives status/pending/continuity, then builds
two optional sub-objects (`runtime`, `acp`) via repeated `latestString(...) ?? latest.X`
conditional-assignment blocks (`:828-858`).
**Impact:** Medium — the `runtime`/`acp` assembly blocks are mechanical and obscure
the actual derivation logic.
**Risk to fix:** Low-Medium — extract `buildRuntime(orderedEvents, latest)` and
`buildAcp(orderedEvents, latest)` pure helpers. Extraction of a sub-expression.
**Effort:** S-M
**behaviorPreserving:** true (pure extract-function of self-contained blocks; same
inputs/outputs, no behavior change).

### P4 — Centralize magic priority/threshold numbers (magic numbers)
**Location:** `priorityFor` `src/index.ts:713-749` (90/80/70/60/50/10/0);
redaction defaults `:134-139` (240/3/20); `DETAIL_CHAR_LIMIT=200` `:331`.
**Smell:** Bare numeric literals encoding a priority ladder and preview budgets.
`priorityFor`'s ladder semantics (what 90 vs 80 means) live only in the literals.
**Impact:** Medium — magic ladder is hard to audit/tune; risk of accidental
reordering.
**Risk to fix:** Low — replace literals with `as const` named constants of the
SAME values (e.g. `PRIORITY_INPUT_AWAITING = 90`).
**Effort:** S
**behaviorPreserving:** true (named constant for identical value).

### P5 — Dedup the "scan events, keep latest field" pattern (duplication)
**Location:** `latestString` `:577-583`, `latestBoolean` `:585-591`, and the
per-status scan in `deriveRuntimeStatus` `:593-620`; also the repeated
`family !== X { continue }` scan shape in `isInputPending` `:622-641` /
`isDeliveryPending` `:643-657`.
**Smell:** `latestString`/`latestBoolean` are identical except the reader fn;
the family-filtered scans share an identical skeleton.
**Impact:** Low-Medium — four+ near-duplicate loops.
**Risk to fix:** Low — `latestString`/`latestBoolean` collapse to one generic
`latestField(events, key, reader)`. Family scans share a `someInFamily(events, family, pred)` helper.
**Effort:** S
**behaviorPreserving:** true (extract identical logic; same results).

---

## Code Smells Table

| # | Location | Principle / Smell | Impact | Risk | Effort |
|---|---|---|---|---|---|
| 1 | `index.ts:1-935` | SRP — 935-line single module, 4 concerns | High | Med | M |
| 2 | `index.ts:241-302` `deriveFamily` | OCP — type-keyed if/includes chain | High | Med | M |
| 3 | `index.ts:304-326` `deriveSeverity` | OCP — string `includes`/`endsWith` chain | Med | Med | S-M |
| 4 | `index.ts:593-620` `deriveRuntimeStatus` | OCP — substring status classifier | Med | Med | S-M |
| 5 | `index.ts:811-886` `deriveSessionRow` | Long method (~75 lines), mixed concerns | Med | Low-Med | S-M |
| 6 | `index.ts:713-749` `priorityFor` | Magic numbers (priority ladder) | Med | Low | S |
| 7 | `index.ts:134-139`, `:331` | Magic numbers (preview limits, detail cap) | Low-Med | Low | S |
| 8 | `index.ts:577-591` | Duplication — `latestString`/`latestBoolean` | Low-Med | Low | S |
| 9 | `index.ts:622-657` | Duplication — family-filtered scan skeleton | Low | Low | S |
| 10 | `index.ts:14-25`, `:65`, `:82-84` | Primitive obsession — status/family/continuity as bare string unions matched by substring | Med | Med | M |
| 11 | `index.ts:224-226` `topLevelString` | `event as unknown as ObjectRecord` cast to read top-level keys | Low | Low | S |
| 12 | `index.ts:461-472` `redactionOptions` | DIP/hidden coupling — reads `process.env['ACP_DASHBOARD_RAW_PAYLOAD']` inside pure transform | Med | Med | S |
| 13 | `index.ts:232-239` | `isRejectionKind` checks `'reject'` AND `'rejected'` — second is subsumed by first (dead branch) | Low | Low | XS |
| 14 | `index.ts:816-819` | Redundant `latest === undefined` guard after non-empty + sort (length already checked `:812`) | Low | Low | XS |
| 15 | `index.ts:265,289,305,309` | Repeated `eventErrorCode`/`isRejectionKind`/`eventKindIncludes` recomputation across `deriveFamily`/`deriveSeverity` | Low | Low | S |

---

## Quick Wins (low risk, low effort)

- **QW1 — `priorityFor` named constants** (`:713-749`): swap the 90/80/70/60/50/10/0
  literals for named `const`s of identical value. *behaviorPreserving.*
- **QW2 — Collapse `latestString`/`latestBoolean`** (`:577-591`) into one generic
  `latestField(events, key, reader)`. *behaviorPreserving.*
- **QW3 — Extract redaction sentinel + limit constants already named** are good;
  also name `DETAIL_CHAR_LIMIT` peers (preview text limit) consistently. *behaviorPreserving.*
- **QW4 — Drop the redundant `'rejected'` substring** in `isRejectionKind` `:238`
  (`includes('reject')` already matches `'rejected'`). Simplify equivalent boolean
  logic; result identical. *behaviorPreserving.*
- **QW5 — Remove redundant post-sort `latest === undefined` guard** `:817-819`
  (length is guaranteed >0 by `:812`). Dead branch removal. *behaviorPreserving.*

---

## Tech Debt

- **Stringly-typed classification (smell #10):** family/severity/status/continuity
  are bare string unions, and runtime values are derived by substring matching on
  `eventKind` (`includes('dead')`, `startsWith('input.')`, etc.). This is the core
  extensibility debt: the projection's contract with upstream `eventKind` naming is
  implicit and untyped. A registry of `{ match, family, severity }` descriptors (or
  an upstream typed discriminant) would make the mapping testable and OCP-friendly.
  Larger design change — out of scope for a pure pass.
- **Env read inside pure transform (smell #12):** `redactionOptions` consults
  `process.env['ACP_DASHBOARD_RAW_PAYLOAD']`, coupling a leaf function to global
  ambient state and making `redactPayload` non-deterministic across environments.
  Threading this through `RedactionOptions` (resolved by the caller) would restore
  purity, but changes who reads env — behavior-affecting, defer.
- **Type-cast escape hatch (smell #11):** `topLevelString` casts the event to a
  record to read arbitrary keys; signals the `HrcLifecycleEvent` shape doesn't fully
  model the `errorCode` top-level field.

---

## Safety Checklist (for the apply stage)

- [ ] Public API must remain unchanged: `projectHrcToDashboardEvent`,
      `deriveSessionRow`, `redactPayload`, `buildSummary`, and all exported types
      / `defaultRedactionOptions` / the `agent-action-render` re-exports.
- [ ] Run `bun test` (both `test/projection.red.test.ts` and
      `test/input-admission-labels.test.ts`) after each change.
- [ ] Run `tsc --noEmit` (typecheck script) — `exactOptionalPropertyTypes`-style
      `| undefined` unions are pervasive; preserve them on any moved declaration.
- [ ] For P2 (`deriveFamily` table): preserve exact short-circuit ordering;
      add a characterization test over current outputs first.
- [ ] Do NOT touch env-read behavior (#12) or the `as unknown as` cast (#11) in a
      behavior-preserving pass.
- [ ] Quick wins QW1/QW2/QW4/QW5 and P3 extraction are safe to apply as a
      behavior-preserving batch.
