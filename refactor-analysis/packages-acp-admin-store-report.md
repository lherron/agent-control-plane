# Refactor Analysis — `packages/acp-admin-store`

SOLID + code-smell audit. **Analysis only** — no source files were modified.

## Scope

| File | Lines | Role |
| --- | --- | --- |
| `src/open-store.ts` | 1518 | Schema/migrations, all six store factories, row mappers, profile validation, store-handle helpers, public open/in-memory factories |
| `src/sqlite.ts` | 93 | Runtime SQLite driver abstraction (Bun vs better-sqlite3) |
| `src/heartbeat-stale.ts` | 81 | Stale-heartbeat sweep + system-event emission |
| `src/index.ts` | 42 | Barrel re-exports |
| **Total source** | **1734** | (tests excluded) |

`open-store.ts` is the gravitational center: it holds ~88% of the source and every concern in the package.

## Scorecard

| Dimension | Grade | Notes |
| --- | --- | --- |
| SRP | D | `open-store.ts` is a 1518-line god-module: DDL, 6 store factories, validation, mappers, handle plumbing |
| OCP | C | Adding a store/table requires editing the central module + duplicating an open/in-memory factory pair |
| LSP | A | No inheritance; no not-implemented overrides |
| ISP | A | Interfaces are small and focused (≤4 members each) |
| DIP | B | `new Database()` hardcoded in `createSqliteDatabase`; driver selection is otherwise abstracted via `SqliteDatabase` interface |
| Duplication | C | 5 near-identical SQL column lists, 6 near-identical open/in-memory factory pairs, repeated `maybe*` mappers, re-validating `profileScalarFromStorage` called twice per field |
| Naming / clarity | B | Mostly clear; `maybeRootDir`/`maybeProjectHomeDir` both read `root_dir` is confusing |
| Test coverage | A | 9 test files, ~1444 test lines covering every store |

## Priority Refactorings

### P1 — Split `open-store.ts` into per-concern modules (SRP)
**Location:** `src/open-store.ts:1-1518`
One file owns: migration DDL (243-350), row type definitions (21-125), actor-stamp serialization (410-431), profile validation (437-565), 9 `maybe*`/`toAdmin*` mappers (567-723), 6 store factories (764-1367), store-handle plumbing (1369-1380), migration runners (1382-1409), and 14 public factory functions (1411-1518). Recommended split: `migrations.ts`, `rows.ts` (row types + mappers), `profile.ts` (validation), `stores/agents.ts` … `stores/heartbeats.ts`, `store-handle.ts`, `open-store.ts` (wiring only).
**Impact:** High (readability, navigation, blast radius). **Risk:** Low-Med (pure file moves + re-exports). **Effort:** M. **behaviorPreserving:** false (module boundaries / import wiring change).

### P2 — Collapse the 6 open/in-memory factory pairs into a generated/parameterized form (OCP, duplication)
**Location:** `src/open-store.ts:1448-1518`
`openSqliteAgentsStore`/`createInMemoryAgentsStore` … `openSqliteHeartbeatsStore`/`createInMemoryHeartbeatsStore` are 12 functions that differ only by which `store.<section>` they hand to `createStoreHandle`. A single `openSqliteSectionStore(options, pick)` / `createInMemorySectionStore(pick)` pair, or a table-driven generator keyed by section name, removes ~70 lines and the per-store edit cost.
**Impact:** Med. **Risk:** Med (public API surface — names are exported and consumed elsewhere). **Effort:** M. **behaviorPreserving:** false (public API/export shape changes).

### P3 — Fix the quadruple-evaluation in `maybeAgentProfile` (duplication / wasted work)
**Location:** `src/open-store.ts:567-616`
Each scalar field calls `profileScalarFromStorage(...)` twice (once in the `!== undefined` guard, once to produce the value) — 4 redundant validator+regex runs per agent read for `displayColor` and `monogram`, and a double call for every string/array field. Compute each value once into a local, then spread conditionally. Behavior is identical (the validator is pure).
**Impact:** Med (perf on list reads; clarity). **Risk:** Low. **Effort:** S. **behaviorPreserving:** true (extract-variable / dedup identical pure calls; same result).

### P4 — Rewrite `MembershipsStore.add` re-read tangle (long method / duplication / dead branch)
**Location:** `src/open-store.ts:1007-1059`
After the INSERT, the same SELECT is prepared and executed up to three times inside a ternary whose `false` branch (`throw 'membership insert failed'`) is effectively unreachable — the row was just inserted in the same connection/transaction. Replace with a single SELECT into a local, mirroring the cleaner pattern already used by `systemEvents.append` (1212-1224). Removes ~15 lines and 2 redundant queries.
**Impact:** Med. **Risk:** Low. **Effort:** S. **behaviorPreserving:** false (error-handling path and query count change observably; keep separate from pure cleanups).

## Code Smells

| # | Location | Smell / Principle | Detail | behaviorPreserving |
| --- | --- | --- | --- | --- |
| 1 | `open-store.ts:1` (whole file) | Large module / SRP | 1518 lines, ~10 concerns | false |
| 2 | `open-store.ts:567-616` | Duplicate pure calls | `profileScalarFromStorage` invoked 2× per field | true |
| 3 | `open-store.ts:1007-1059` | Long method + dead branch + dup query | `memberships.add` re-prepares same SELECT 3× | false |
| 4 | `open-store.ts:830-833, 843-845, 961, 972, 1081, 1166, 1178, 1214, 1252, 1333, 1346, 1358` | Duplication (magic strings) | Identical SELECT column lists repeated across list/get/insert-readback for each table; one shared const per table would dedup | false (string is load-bearing in queries; treat as careful refactor) |
| 5 | `open-store.ts:1448-1518` | Duplication / OCP | 6 open/in-memory factory pairs | false |
| 6 | `open-store.ts:665-678` | Confusing naming / redundant spread | `toAdminProject` spreads `maybeProjectHomeDir(row.root_dir)` AND `maybeRootDir(row.root_dir)` — two names, same column, emitting both `homeDir` and `rootDir` from one value | false (drops/renames an output field if changed) |
| 7 | `open-store.ts:626-648` | Duplication | `maybeDisplayName`/`maybeHomeDir`/`maybeDefaultAgentId`/`maybeRootDir`/`maybeProjectHomeDir`/`maybeLinkedAgentId` are the same `value===null?undefined:{key:value}` shape 6× | true (if collapsed to one generic helper with identical output) |
| 8 | `open-store.ts:437-438` | Magic numbers (named, but local) | `PROFILE_ARRAY_LIMIT`/`PROFILE_ARRAY_ITEM_LIMIT` good; but `slice(0,16)` at 1088 and `busy_timeout = 5000` (406) are bare | true (replace literal with same-value named const) |
| 9 | `open-store.ts:1088` | Magic number / primitive obsession | `randomUUID().replace(/-/g,'').slice(0,16)` id-gen logic inline; should be a named helper | true (extract function, same output) |
| 10 | `open-store.ts:1265-1325` | Duplication | `heartbeats.upsert` has two near-identical INSERT…ON CONFLICT branches differing only by the two target columns | false (SQL/branch merge could alter COALESCE semantics) |
| 11 | `open-store.ts:528-565` | Duplication | `profileArrayFromStorage` re-implements the per-item trim/length validation already in `validateProfileStringArray` (489-503) | false (validation re-use could change error timing) |
| 12 | `heartbeat-stale.ts:48-58` | Nested loop / N+1 | Per stale agent, lists all projects then lists memberships per project to resolve a projectId — O(stale × projects) queries | false (query strategy / behavior on ties) |
| 13 | `sqlite.ts:91` | Top-level await + DIP | Module-level `await loadSqliteDatabaseConstructor()` runs driver import at import time; `new Database(dbPath)` is hardcoded in `createSqliteDatabase` (403) with no injection seam | false |
| 14 | `open-store.ts:101-103, 380-383` | Primitive obsession (mild) | Actor stamps stored as JSON strings, hand-serialized in 3 near-identical functions (418-431) | true (only if consolidating identical serialization) |

## Quick Wins

- **P3 / smell #2:** Dedup the double `profileScalarFromStorage` calls in `maybeAgentProfile` — pure, fast, removes redundant regex work. *(behaviorPreserving)*
- **Smell #7:** Collapse the six `maybe*` single-key wrappers into one generic `maybeField(key, value)` helper. *(behaviorPreserving)*
- **Smell #9:** Extract the inline `ifid_…` id generator (1088) into a named `generateIdentityId()`. *(behaviorPreserving)*
- **Smell #8:** Name the `5000` busy-timeout and the `16` id-length literals as constants. *(behaviorPreserving)*

## Tech Debt

- **Driver bootstrap is import-time and untestable in isolation** (`sqlite.ts:91`). Top-level await + hardcoded `new Database()` means the concrete driver can't be substituted for a fake without monkeypatching the module. A factory/injection seam would let store tests run without a real SQLite binding and remove the import-time side effect.
- **Adding a new store/table is a multi-edit ritual:** row type, mappers, factory, the central `store` object (1422-1439), `AdminStore` interface (356-369), two public factory functions, and `index.ts` exports must all change in lockstep (OCP friction).
- **Shared SQL column lists are copy-pasted** (smell #4); a column drift between an INSERT-readback and a list query would silently desync row shapes.
- **`heartbeat-stale.ts` projectId resolution is O(projects) per stale agent** and picks the first matching project nondeterministically (membership iteration order); a single membership-by-agent query would be both faster and clearer.

## Safety Checklist (for the apply stage)

- Behavior-preserving items (safe, mechanical): smell #2, #7, #8, #9, and #14-if-consolidated. These cannot change observable output.
- **Do NOT** auto-apply without re-verification: P1/P2 (module + public-API reshape), P4 / smell #3 (changes error path + query count), smell #4 (SQL strings are load-bearing — any typo breaks reads), smell #6 (touches emitted DTO fields `homeDir`/`rootDir`), #10 (COALESCE merge semantics), #11/#12/#13 (validation timing, query strategy, driver wiring).
- Run the existing `__tests__` suite (9 files) after every change; they cover all six stores and the stale sweep.
- The `toAdminProject` double-emit of `homeDir`+`rootDir` (smell #6) is likely intentional backward-compat aliasing — confirm consumers before "simplifying".
