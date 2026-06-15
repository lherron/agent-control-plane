# Refactor analysis — `packages/acp-ops-reducer`

## Summary

`acp-ops-reducer` is a tiny (single-file, ~345 LOC) pure-functional reducer over
`DashboardEvent` streams for the operator session dashboard. It exposes a state
shape (`ReducerState`) and a set of pure transition functions (`applyEvent`,
`reconnect`, `setWindow`, `compact`), a stream parser (`parseNdjsonChunk`), and
two selectors (`selectVisibleEvents`, `selectSortedRows`). It re-exports
`DashboardEvent`/`SessionTimelineRow` from `acp-ops-projection` and delegates all
row derivation to `deriveSessionRow` there.

Package-type profile: **general / pure-data-reducer**. There is no concurrency
(every function returns a new immutable state; `Map`s are copied before mutation),
no I/O, no perf-sensitive hot loop worth memoizing at this size. The relevant
swaps are therefore boundary alignment ([T07]), de-abstraction of unused surface
([T16]), and one missing-abstraction extraction across the package boundary
([T15]) for redaction logic that is **duplicated verbatim** from
`acp-ops-projection`.

The single most important finding is that the credential-redaction logic
(constants + key-matching helpers) is copy-pasted from `acp-ops-projection`,
where the same data already lives but is not exported. The largest behavior-safe
cleanup is narrowing the public surface to what the sole consumer
(`acp-viewer`) actually imports.

There is good characterization coverage already (`test/reducer.red.test.ts`, 12
tests) — a green run gates everything below.

## Public boundary (assess FIRST) — verdict: **needs-care (leaky + over-wide)**

Exports from `src/index.ts`:

| Export | Used by consumer (`acp-viewer`)? | Notes |
|---|---|---|
| `applyEvent` | yes | core |
| `reconnect` | yes | core |
| `compact` | yes | core |
| `selectSortedRows` | yes | core |
| `selectVisibleEvents` | yes (with `{ family }` only) | core; only one filter field exercised in prod |
| `ReducerState` (type) | yes | core |
| `DashboardEvent`, `SessionTimelineRow` (re-export) | yes | convenience re-export, fine |
| `setWindow` | **no** | only used by tests; not in `acp-viewer` |
| `parseNdjsonChunk` | **no** | dead at the package boundary — the mobile adapter feeds `DashboardEvent[]` directly (see consumer header comment `use-reducer-store.ts:20-23`); the NDJSON path was retired |
| `ParsedNdjsonChunk` (type) | **no** | only the return type of unused `parseNdjsonChunk` |
| `ReducerWindow` (type) | **no** | structural-only inside `ReducerState` |
| `ReducerEventFilters` (type) | **no** | consumer passes an inline object literal, never imports the type |

Two boundary problems:

1. **Over-wide / possibly-dead surface.** `parseNdjsonChunk`/`ParsedNdjsonChunk`
   appear vestigial: the consumer comment explicitly states the reducer is now
   fed `DashboardEvent[]` "exactly as the NDJSON path did", and no other package
   imports `parseNdjsonChunk`. It is still covered by a red test, so it is
   contractually retained, not strictly dead — treat as **possibly-dead, verify
   before removal**.

2. **Leaky duplication across the boundary.** The redaction constants and key
   matcher in this package are a verbatim fork of `acp-ops-projection`'s internal
   redaction (`CREDENTIAL_KEY_PARTS`, `RAW_PROVIDER_KEYS`, `REDACTED_VALUE`,
   `isRecord`, `normalizedKey`, `shouldRedactKey` are character-for-character
   identical in both files). The intent ("redact credential-shaped keys") lives
   in projection but is not exported, so the reducer re-implements it. This is the
   leaky side of the boundary: the abstraction exists but isn't reachable.

The core transition/selector functions are well-shaped: pure, immutable,
single-purpose, idempotent (id-dedupe in `applyEvent`), and total over malformed
timestamps (`compareByTimestamp` handles non-finite `Date.parse`). That part of
the boundary is **sound**.

## Findings by mechanism (outside-in)

### F1 — [T07] Narrow public surface: gate/remove `parseNdjsonChunk` + `ParsedNdjsonChunk`
- **Location:** `packages/acp-ops-reducer/src/index.ts:33-37` (type),
  `:275-295` (function).
- **Mechanism repaired:** export surface wider than actual usage — a transport
  parser shipped in the public API of a *reducer* package, no consumer left.
- **Direction:** remove (from public surface) — or at minimum stop exporting.
- **Preservation rung:** behavior-preserving for production (no prod consumer);
  but `test/reducer.red.test.ts:88-100` asserts the NDJSON contract, so removal
  changes the *test* surface. Honor Expand/Contract: this package has exactly one
  external consumer, so [M02] reduces to "confirm no consumer + drop". The red
  test is a spec artifact (`SESSION_DASHBOARD.md §12/§19.1`), so dropping the
  function is a **spec/contract decision, not a mechanical refactor**.
- **Falsifiable signal:** `grep -rn parseNdjsonChunk packages apps --include=*.ts`
  returns only this package and its test. Confirmed at analysis time.
- **Risk:** Med · **API-impact:** public-surface · **Effort:** S.
- **Tests:** removing requires deleting the NDJSON red test. Keeping-but-unexporting
  still resolves because the test imports from `../src/index.js`. Prefer keeping
  until the spec owner confirms the NDJSON path is retired.
- **Contraindication:** the red test ties this to `SESSION_DASHBOARD.md`; if the
  NDJSON ingestion path is still a documented requirement (even if mobile bypasses
  it today), this is load-bearing spec coverage, not dead code. **Do not
  auto-remove.**

### F2 — [T15] Extract missing abstraction: redaction constants/helpers duplicated from `acp-ops-projection`
- **Location:** `packages/acp-ops-reducer/src/index.ts:45-78`
  (`REDACTED_VALUE`, `CREDENTIAL_KEY_PARTS`, `RAW_PROVIDER_KEYS`, `isRecord`,
  `normalizedKey`, `shouldRedactKey`) duplicates
  `packages/acp-ops-projection/src/index.ts:164,168-184,187-200`.
- **Mechanism repaired:** duplicated intent across a package boundary — the
  credential-key policy is defined twice and can silently drift (adding a new
  credential key part in one file only would create a redaction gap on one
  surface). The abstraction exists in projection but isn't exported.
- **Direction:** relocate/centralize — export the key-matching predicate +
  constants from `acp-ops-projection` (reducer already depends on it) and import
  them here. The reducer's `sanitizePayloadPreview`/`sanitizeEvent` (the *shape*
  of the walk: redact-on-key, recurse) stays local since it differs from
  projection's depth/array-limited `redactValue`; only the policy data is shared.
- **Preservation rung:** exact policy preserved — keep `CREDENTIAL_KEY_PARTS` and
  `RAW_PROVIDER_KEYS` identical (they currently are); exporting the existing ones
  guarantees that, removing the local copies removes the drift surface.
- **Falsifiable signal:** after the change only one copy of the constant block
  exists; redaction red test (`test/reducer.red.test.ts:191-212`) stays green.
- **Risk:** Low (consume an export byte-identical to the local copy) ·
  **API-impact:** public-surface (adds a small export to `acp-ops-projection`;
  internal-only for `acp-ops-reducer`, which only loses private symbols) ·
  **Effort:** S.
- **Contraindication:** if the two policies are *intended* to diverge (reducer
  redacts a different key set than projection), this is deliberate, not
  duplication. At analysis time they are identical, so it reads as accidental
  duplication. The projection export is the cross-package change needing a human
  nod.

### F3 — [T16] (considered) `tieBreak` callback in `compareByTimestamp` — leave as-is
- **Location:** `packages/acp-ops-reducer/src/index.ts:125-138`, called at
  `:140-146` (`compareEvents`) and `:331-343` (`selectSortedRows`).
- **Mechanism examined:** a higher-order `() => number` tie-break parameter with
  two call sites. Pressure-tested: the two tie-breaks genuinely differ
  (`hrcSeq` only vs. `hostSessionId` then `generation`), so the callback is real
  parameterization, **not** a one-implementor seam.
- **Direction:** none — keep. Listed for completeness of the de-abstraction pass.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** none.

### F4 — [T15] (verify-only) supersession magic constants — already extracted
- **Location:** `packages/acp-ops-reducer/src/index.ts:41-43`
  (`SUPERSEDED_PRIORITY_FLOOR = 80`, `SUPERSEDED_COLOR_ROLE`,
  `SUPERSEDED_CONTINUITY`).
- **Mechanism:** magic-number obsession — **already repaired**; named and used
  once each in `markSupersededRows`. Further bundling into an object would be
  premature (single use site). No change.
- **Risk:** n/a · **API-impact:** internal-only · **Effort:** none.

### F5 — [T07] Type ergonomics: `ReducerEventFilters`/`ReducerWindow` not consumed externally
- **Location:** `packages/acp-ops-reducer/src/index.ts:6-10` (`ReducerWindow`),
  `:21-31` (`ReducerEventFilters`).
- **Mechanism repaired:** exported types no consumer imports widen the apparent
  contract. `ReducerWindow` is purely structural inside `ReducerState` (consumer
  builds the window inline at `use-reducer-store.ts:60-65`); `ReducerEventFilters`
  is passed as an inline literal at `use-reducer-store.ts:112-114`.
- **Direction:** keep as convenience/documenting types OR de-export for a strict
  minimal surface. Lean keep — cheap, zero runtime cost.
- **Preservation rung:** behavior-preserving (types only); consumer still compiles
  with inline literals after de-export.
- **Falsifiable signal:** `grep` shows zero external imports of either type
  (confirmed).
- **Risk:** Low · **API-impact:** public-surface (removing an exported type) ·
  **Effort:** S.
- **Contraindication:** exported types aid downstream readability at no runtime
  cost; narrowing is cosmetic. Defer unless a strict minimal surface is wanted.

### F6 — [T40] Characterization safety net — present; one selector-filter gap
- **Location:** `packages/acp-ops-reducer/test/reducer.red.test.ts` (12 tests).
- **Mechanism:** the make-safe gate. Coverage spans replay ordering, idempotency,
  dedupe-on-replay, NDJSON recovery, tie-break, generation rotation/supersession,
  stale-context visibility, in-flight branches, redaction, compaction, reconnect.
- **Gap:** no direct test of `selectVisibleEvents` filter fields other than
  `severity`/`{}` — no coverage of `scopeRef`/`laneRef`/`runtimeId`/`runId`/
  `family` filtering, nor of `fromTs`/`toTs` bounds via the selector. Add
  characterization for those arms **before** any change touching
  `selectVisibleEvents`.
- **Risk:** Low · **API-impact:** internal-only (test) · **Effort:** S.

## Deliberately left alone (where-NOT)

- **`compareByTimestamp` tie-break callback (F3)** — two genuinely different
  tie-break strategies; the HOF is real parameterization, not a one-implementor
  seam. Not de-abstracted.
- **Supersession constants (F4)** — already extracted and named; no further
  bundling (single use site → premature).
- **Local `sanitizePayloadPreview` walk** — intentionally distinct from
  projection's depth/array-bounded `redactValue` (the reducer does an unbounded
  key-redact walk on an already-previewed payload as defense-in-depth). Only the
  *policy data* (F2) is shared; the walk stays local. Do not collapse the two
  redaction walks into one — different responsibilities.
- **Immutable `Map` copy-on-write pattern** (`new Map(state.x)` in every
  transition) — correct for a pure reducer feeding a zustand store; not a
  concurrency smell, no [T31]/[T32] applies.
- **`rebuildRows` full recompute in `setWindow`/`compact`** — O(events) recompute
  per window change is fine at dashboard scale and is the simplest correct form;
  no [T25]/[T26] memoization warranted (would add cache-invalidation complexity
  for no measured need).
- **`applyEvent` incremental single-row update vs. `rebuildRows`** — the asymmetry
  (incremental on apply, full rebuild on window/compact) is deliberate and
  correct; not a cohesion smell.

## If applying — outside-in sequence

1. **[T40]** Run `bun test` in the package; confirm 12 green. Add the missing
   `selectVisibleEvents` filter-arm characterization (F6) **before** touching any
   selector. (gate)
2. **[T15] F2** (Low, highest-leverage safe change): export
   `CREDENTIAL_KEY_PARTS`, `RAW_PROVIDER_KEYS`, `REDACTED_VALUE`, and a key
   predicate (`shouldRedactKey`/`normalizedKey`/`isRecord` or a single
   `isCredentialKey(key)`) from `acp-ops-projection`; import them in the reducer;
   delete the local copies. Re-run the redaction red test (`:191-212`) — must stay
   green. This touches a *second* package's public surface → human review.
3. **[T07] F1 / F5** (public-surface, deferred): only after a spec owner confirms
   the NDJSON ingestion path is retired, remove `parseNdjsonChunk`/
   `ParsedNdjsonChunk` and their red test; optionally de-export the never-imported
   `ReducerEventFilters`/`ReducerWindow` types. These change the documented
   contract → not auto-applicable.

## Safety checklist

- [ ] `bun test` green before and after every step (12 baseline tests).
- [ ] `bun run typecheck` green (builds `acp-ops-projection` first per package.json
      scripts).
- [ ] After F2: redaction red test passes with the shared policy; `CREDENTIAL_KEY_PARTS`
      / `RAW_PROVIDER_KEYS` byte-identical to pre-change (no key added/removed).
- [ ] `acp-viewer` typechecks/builds against the reducer (sole consumer) — verify
      `selectSortedRows`/`selectVisibleEvents`/`applyEvent`/`compact`/`reconnect`/
      `ReducerState` signatures unchanged.
- [ ] No biome `useValidTypeof` regression (F2 does not parameterize a `typeof`
      literal — safe).
- [ ] F1/F5 NOT applied without spec-owner sign-off (public-surface contract
      change, tied to `SESSION_DASHBOARD.md`).
- [ ] Churn note: F2 adds exports to `acp-ops-projection` (one extra package in the
      diff) and may dirty its `dist`/tsbuildinfo on rebuild — revert build-artifact
      churn before reporting.
