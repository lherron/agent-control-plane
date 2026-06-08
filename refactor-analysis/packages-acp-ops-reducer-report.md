# Refactor Analysis — `packages/acp-ops-reducer`

Methodology: SOLID + code-smell audit (ANALYSIS ONLY, read-only).
Date: 2026-06-07

## Scope

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 340 | Entire package: pure reducer over `DashboardEvent`s — state shape, event apply, windowing/compaction, NDJSON parsing, redaction, selectors |
| `test/reducer.red.test.ts` | 235 | Red/behavioral tests (reference only) |

Total source lines analyzed: **340** (single source file). Dependency: `acp-ops-projection` (`deriveSessionRow`, `DashboardEvent`, `SessionTimelineRow`).

This is a small, deliberately pure/functional module. It is in good shape overall: no classes, no `new Concrete()` wiring, no inheritance, immutable update patterns throughout. Findings are minor quality/clarity items, not structural rot.

## Scorecard

| Dimension | Grade | Notes |
|-----------|-------|-------|
| SRP | B | One file mixes 4 concerns (redaction, event ordering, row rebuild, NDJSON parse, selectors). No function is egregiously long; largest is `selectVisibleEvents` (~30 lines). |
| OCP | A- | No type-keyed switch chains. Filter logic is a flat predicate chain (acceptable for a fixed filter set). |
| LSP | A | No inheritance / overrides. |
| ISP | A | Types are data records, not fat interfaces. Largest is `ReducerEventFilters` (9 optional members) — under the 10-member threshold. |
| DIP | A | Pure functions; sole collaborator (`deriveSessionRow`) is imported, not instantiated. |
| Duplication | B | Timestamp-compare-with-validity-tiebreak logic duplicated between `compareEvents` and `selectSortedRows`. Repeated `Date.parse` + `Number.isFinite` guards in `selectVisibleEvents`. |
| Magic numbers | B | `80` (priority floor) and `'warning'`/`'blocked'` literals embedded in `markSupersededRows`. |
| Dead code | C | `ReducerState.droppedEvents` is declared and initialized but never read or written by any reducer function. |

Overall: **B+ / healthy.** Mostly Quick Wins; one dead-field cleanup worth confirming.

## Priority Refactorings

### P1 — Extract duplicated timestamp-ordering comparator
- **Location:** `src/index.ts:121-136` (`compareEvents`) and `src/index.ts:319-340` (`selectSortedRows`).
- **Principle/smell:** Duplication (DRY) / SRP.
- **Detail:** Both implement the same pattern: parse two ISO timestamps, prefer finite over non-finite, fall back to a secondary key (`hrcSeq` vs `hostSessionId`/`generation`). The "valid-vs-invalid tiebreak" block (`if (leftValid !== rightValid) return leftValid ? -1 : 1`) is copied verbatim.
- **Impact:** Medium — keeps ordering semantics consistent if tie-break rules change.
- **Risk:** Low. **Effort:** Low.
- **Behavior-preserving:** Yes (extract a shared `compareByTimestamp(leftTs, rightTs, tieBreak)` helper returning identical results).

### P2 — Name the magic priority floor and superseded-row visual constants
- **Location:** `src/index.ts:160-171` (`markSupersededRows`).
- **Principle/smell:** Magic number / primitive obsession.
- **Detail:** `Math.max(row.visualState.priority, 80)`, `colorRole: 'warning'`, `continuity: 'blocked'` are inline literals with no named meaning. `80` is an unexplained priority threshold.
- **Impact:** Low-Medium — clarifies intent ("superseded rows are demoted to warning priority ≥ 80").
- **Risk:** Low. **Effort:** Low.
- **Behavior-preserving:** Yes (replace literals with `const`s of identical values).

### P3 — Resolve the unused `droppedEvents` state field
- **Location:** `src/index.ts:16` (declared in `ReducerState`); never written. Only initialized in tests (`test/reducer.red.test.ts:39`).
- **Principle/smell:** Dead code / incomplete contract.
- **Detail:** `droppedEvents` is part of the public `ReducerState` shape but no reducer (`applyEvent`, `parseNdjsonChunk`, etc.) ever increments it, even though `parseNdjsonChunk` computes `droppedLines` that logically maps to it. Either it is dead and should be removed, or it represents missing wiring (NDJSON parse drops are not propagated into state).
- **Impact:** Medium — a state field that always reads `0` is misleading to consumers.
- **Risk:** Medium — removal changes the public `ReducerState` type (breaking for callers); wiring it up changes observable values. NOT a pure refactor.
- **Behavior-preserving:** No (public type change and/or new behavior). Flag for human decision in apply stage.

### P4 — Split file along concern boundaries (optional, SRP)
- **Location:** whole file `src/index.ts:1-340`.
- **Principle/smell:** SRP (one module, multiple concerns).
- **Detail:** Cohesive groups: (a) redaction (`isRecord`, `normalizedKey`, `shouldRedactKey`, `sanitizePayloadPreview`, `sanitizeEvent`, lines 39-119), (b) ordering/row-rebuild (`compareEvents`, `rowIdFor`, `eventsForRow`, `markSupersededRows`, `rebuildRows`, lines 121-196), (c) public reducer ops + selectors. Moving (a) and (b) into `redaction.ts` / `rows.ts` and re-exporting would shrink the entry point.
- **Impact:** Low (readability/navigability only; the module is small).
- **Risk:** Low-Medium — file moves and import rewiring can change the public surface if not re-exported exactly.
- **Behavior-preserving:** No (file moves / module restructuring; treat as non-pure).

## Code Smells

| # | Location | Smell | Severity | Notes |
|---|----------|-------|----------|-------|
| 1 | `index.ts:121-136` + `319-340` | Duplicated comparator logic | Med | See P1. |
| 2 | `index.ts:160-171` | Magic number `80`, literal `'warning'`/`'blocked'` | Low | See P2. |
| 3 | `index.ts:16` | Unused state field `droppedEvents` | Med | See P3 — never mutated. |
| 4 | `index.ts:287-317` | Repeated `Date.parse`+`Number.isFinite` guard in `fromTs`/`toTs` branches | Low | Two near-identical range checks; extractable to `withinBound(eventTs, bound, dir)`. |
| 5 | `index.ts:153,159` | Repeated `maxGenerationByHost.get(...) ?? row.generation` fallback | Low | Same default-resolution expression twice within `markSupersededRows`. |
| 6 | `index.ts:209` | Full row recomputation via `eventsForRow` scans ALL events per `applyEvent` | Low-Perf | O(n) filter over entire event map on every event; fine at current scale, watch if event volume grows. Not a correctness issue. |
| 7 | `index.ts:21-31` | `ReducerEventFilters` — 9 optional members (primitive obsession) | Low | Under ISP threshold; flat string filters acceptable for now. |

## Quick Wins (low risk, low effort, behavior-preserving)

1. Extract shared `compareByTimestamp` tiebreak helper used by `compareEvents` and `selectSortedRows` (P1).
2. Replace `80` / `'warning'` / `'blocked'` in `markSupersededRows` with named constants of identical value (P2).
3. Extract a `withinTimeBound` predicate to dedupe the `fromTs`/`toTs` range checks in `selectVisibleEvents` (smell #4).
4. Bind `maxGenerationByHost.get(row.hostSessionId) ?? row.generation` to a local in `markSupersededRows` to remove the repeated lookup (smell #5).

## Tech Debt

- **`droppedEvents` contract gap (P3):** highest-value real debt. Decide intent — wire NDJSON `droppedLines` (and any apply-time drops) into `ReducerState.droppedEvents`, or remove the field. Currently a silent always-zero counter that consumers may trust.
- **Per-event O(n) row rebuild (smell #6):** acceptable now; revisit if the reducer is fed high-frequency streams (incremental per-row event indexing would remove the full-map scan in `applyEvent`).
- **Module fan-out (P4):** low-priority; only worth doing if this file keeps growing.

## Safety Checklist (for apply stage)

- [ ] P1, P2, Quick Wins 1-4: pure — verify identical comparator return values and constant values; run `bun test`.
- [ ] P3 (`droppedEvents`): NOT pure — requires a human decision (remove field vs. wire it). Do not auto-apply.
- [ ] P4 (file split): NOT pure — re-export every current public symbol from `src/index.ts` verbatim; verify `dist` exports and downstream imports (`acp-ops-projection` consumers) unchanged.
- [ ] Preserve the public exported surface: `applyEvent`, `reconnect`, `setWindow`, `compact`, `parseNdjsonChunk`, `selectVisibleEvents`, `selectSortedRows`, and all exported types.
- [ ] Run `bun run typecheck` and `bun test` after each change.
