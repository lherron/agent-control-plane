# Refactor Analysis — `packages/wrkq-lib`

ANALYSIS ONLY. No source was modified. Read-only SOLID + code-smell audit.

- Package: `packages/wrkq-lib`
- Source root: `packages/wrkq-lib/src`
- Files analyzed (non-test `*.ts`): 15
- Total source lines: 1313

## Scorecard

| Dimension | Rating | Notes |
|---|---|---|
| SRP (Single Responsibility) | Good | Repos, row-mappers, and helpers are cleanly separated. No file > 167 lines; no function > ~45 lines. |
| OCP (Open/Closed) | Good | Only minor state-name mapping conditionals; no type-keyed switch chains. |
| LSP (Liskov) | Good | Repo classes implement `acp-core` store interfaces faithfully; no not-implemented / throw-only overrides. |
| ISP (Interface Segregation) | Good | `SqliteStatement`/`SqliteDatabase` (sqlite.ts) and `WrkqStore` are small and focused. No fat interfaces. |
| DIP (Dependency Inversion) | Mostly good | Repos depend on the `SqliteDatabase` abstraction injected via `RepoContext`. `open-store.ts` wires concretes directly (acceptable composition root) and `actorResolver` is `new`-ed there. |
| DRY | Fair | A handful of repeated SQL idioms (task-uuid lookup, next-id GLOB SELECT) and one fully duplicated role-map reducer. |
| Dead code | Fair | `mapping/role-assignment-row.ts` is unreferenced. |
| Type safety | Good | Heavy use of `as Row` casts on raw SQL results (unavoidable with the thin sqlite wrapper) but localized. |

Overall: a small, well-structured persistence library. No structural SOLID emergencies. The actionable work is a cluster of low-risk DRY / dead-code / magic-number cleanups.

## Priority Refactorings

### P1 — Remove dead module `mapping/role-assignment-row.ts`
- Location: `packages/wrkq-lib/src/mapping/role-assignment-row.ts:1-13`
- Principle/smell: Dead code.
- Detail: `RoleAssignmentRow` and `mapRoleAssignmentRows` are defined here but the module is not exported from `index.ts` and is imported nowhere. `repos/shared.ts:60-75` (`loadRoleMap`) re-declares an identical `RoleAssignmentRow` type and inlines the exact same `reduce` body, so this module is pure duplication that has drifted out of use.
- Impact: ~13 lines of unreachable code that invites confusion (two "row → RoleMap" code paths).
- Risk: Low (file is provably unreferenced). Effort: Trivial.

### P2 — Extract the repeated "lookup task uuid or return empty" idiom
- Location: `repos/evidence-repo.ts:16-22`, `repos/transition-log-repo.ts:64-70`, `repos/role-assignment-repo.ts:11-19`
- Principle/smell: DRY / duplication.
- Detail: Three read paths each inline `SELECT uuid FROM tasks WHERE id = ?` followed by the same `{ uuid: string } | undefined` cast and undefined guard. `shared.ts` already exposes `getTaskLookup` (returns `{uuid, etag}`) and `requireTaskLookup`; a `findTaskUuid(sqlite, id): string | undefined` helper (or reusing `getTaskLookup(...)?.uuid`) would collapse all three.
- Impact: Removes 3 copies of an easily-drifting SQL+guard pattern.
- Risk: Low (behavior-identical helper extraction). Effort: Small.

### P3 — Replace magic literals in the task INSERT with named constants
- Location: `repos/task-repo.ts:60-63` (values `3`, `'task'`, `''`, `''`) bound to columns `priority`, `kind`, `description`, `specification`.
- Principle/smell: Magic numbers / magic strings.
- Detail: The `.run(...)` positional args use bare literals whose column meaning is only inferable by counting against the `INSERT` column list. Named constants (`DEFAULT_TASK_PRIORITY = 3`, `DEFAULT_TASK_KIND = 'task'`, `EMPTY_DESCRIPTION = ''`) make the binding self-documenting and reduce positional-arg miscount risk.
- Impact: Readability + safer future edits to the wide positional `.run()`.
- Risk: Low (same values). Effort: Trivial.

### P4 — De-duplicate the "next sequential id" GLOB SELECT
- Location: `actor-resolver.ts:47-55` (`A-%05d` / `A-[0-9]*`) and `repos/evidence-repo.ts:82-90` (`EV-%05d` / `EV-[0-9]*`)
- Principle/smell: Duplication / structural repetition.
- Detail: Both compute the next id with the same `printf('PREFIX-%05d', COALESCE(MAX(CAST(substr(id, N) AS INTEGER)), 0) + 1)` GLOB pattern, differing only in prefix, substr offset, and table. A shared `nextSequentialId(sqlite, { table, prefix, substrFrom })` helper would unify them.
- Impact: One canonical id-generation routine instead of two copies that must stay in lockstep.
- Risk: Medium — the two queries differ in `substr` offset (3 vs 4) and table; parameterizing SQL identifiers (table/column) requires care since they cannot be bound as `?` placeholders. Not a pure refactor. Effort: Small-Medium.

## Code Smells

| Location | Smell | Severity | Notes |
|---|---|---|---|
| `mapping/role-assignment-row.ts:1-13` | Dead code | Med | Unreferenced module duplicated by `shared.ts:loadRoleMap`. |
| `repos/evidence-repo.ts:16-22`, `repos/transition-log-repo.ts:64-70`, `repos/role-assignment-repo.ts:11-19` | Duplicated SQL + guard | Med | "task uuid lookup or empty" repeated 3x. |
| `repos/task-repo.ts:60-63` | Magic numbers/strings | Low | `3`, `'task'`, `''`, `''` in positional INSERT. |
| `actor-resolver.ts:47-55` + `repos/evidence-repo.ts:82-90` | Duplicated id-gen query | Med | Same GLOB/printf next-id idiom in two places. |
| `mapping/task-row.ts:85-111` (`decodeTaskMeta`) | Nested conditional / mixed concerns | Low-Med | 3 levels of branching to strip the `acp.kind` sidecar and prune empties; correct but dense. Candidate for small extract-method (`stripAcpKind`). |
| `mapping/task-row.ts:33-47` | Paired conversion functions | Low | `mapWrkqStateToLifecycleState` / `mapLifecycleStateToWrkqState` are an `active`↔`in_progress` bidirectional map expressed as two single-branch ifs. Could be a small const map, but current form is clear; low value. |
| `repos/task-repo.ts:34-72`, `repos/transition-log-repo.ts:119-145`, `repos/evidence-repo.ts:51-105` | Wide positional `.run(...)` | Low | Long positional arg lists against multi-column INSERTs; correctness depends on order matching the column list. Inherent to the sqlite wrapper; low priority but worth a comment or column/value zip helper. |
| `mapping/transition-row.ts:51-59` | Repeated array-of-string filter | Low | Three near-identical `Array.isArray(...) ? ...filter(isString) : []` blocks in `readTransitionMeta`; extractable to `readStringArray(parsed, key)`. |
| `mapping/task-row.ts:55-56` | Primitive obsession / sentinel | Low | `phase` uses both `null` and `''` as "absent" across the row/Task boundary (also `transition-row.ts:118-123`). Intentional DB-vs-domain mapping, but the dual empty representation is a latent footgun. |

## Quick Wins

1. Delete `mapping/role-assignment-row.ts` (P1) — pure dead-code removal, behavior-preserving.
2. Name the 4 magic literals in `repos/task-repo.ts:60-63` (P3) — behavior-preserving constants.
3. Extract `readStringArray(parsed, key)` in `mapping/transition-row.ts:51-59` — behavior-preserving dedup of 3 identical filter blocks.
4. Extract `findTaskUuid` and reuse across the 3 read repos (P2) — behavior-preserving helper.

## Tech Debt

- **Two parallel role-map mappers**: `shared.ts:loadRoleMap` and the dead `mapping/role-assignment-row.ts` encode the same transform. Consolidating now (delete dead one) prevents future drift; longer term `loadRoleMap` could be split into "fetch rows" + "fold rows → RoleMap" so the fold is reusable/testable.
- **Sequential-id generation in SQL**: the `MAX(CAST(substr(...)))+1` GLOB approach (actor-resolver, evidence-repo) is race-prone outside a transaction and duplicated. Both call sites currently run inside `sqlite.transaction(...)`, so it is safe today, but it is fragile debt — any new caller forgetting the transaction wrapper reintroduces a race. Centralizing (P4) also centralizes that invariant.
- **Top-level `await` module init in `sqlite.ts:91`**: `const SqliteDatabase = await loadSqliteDatabaseConstructor()` makes the module's default export depend on top-level await and a runtime `Bun` global check. Not a refactor target, but a portability/debt note for ESM consumers.
- **Dual `null`/`''` "empty" sentinel for `phase`/lifecycle** crossing the DB↔domain boundary (task-row, transition-row) is implicit contract debt worth documenting.

## Safety Checklist (for downstream apply stage)

- [ ] P1 (delete dead module): confirm no import of `role-assignment-row` anywhere outside the package before deletion: `grep -r "role-assignment-row" packages/`. Expect zero hits.
- [ ] P2/P4 (helper extraction): preserve exact SQL text and the `undefined`/empty-array return semantics; run the package test suite.
- [ ] P3 (named constants): constants MUST hold the identical values (`3`, `'task'`, `''`, `''`) and stay in the same positional order in `.run(...)`.
- [ ] P4 (id-gen unify): NOT behavior-preserving — verify `substr` offsets (3 for `A-`, 4 for `EV-`) and table/prefix are correctly parameterized; never interpolate untrusted identifiers. Add/keep a test that asserts id format for both actors and evidence.
- [ ] After any change: `tsc` typecheck + existing `*.test.ts` in the package must pass; no public export in `index.ts` changes.
