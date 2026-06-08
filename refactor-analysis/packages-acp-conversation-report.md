# Refactor Analysis — `packages/acp-conversation`

Methodology: SOLID + code-smell audit (ANALYSIS ONLY). No source modified.
Date: 2026-06-07

## Scope

| File | Lines | Role |
|------|------:|------|
| `src/open-store.ts` | 560 | Migrations, types, `ConversationStore` interface, full SQLite store impl |
| `src/sqlite.ts` | 93 | Bun/better-sqlite3 driver abstraction + adapters |
| `src/index.ts` | 21 | Barrel re-exports |
| `src/__tests__/turns-store.test.ts` | 147 | Tests (not in refactor scope) |
| `src/__tests__/threads-store.test.ts` | 175 | Tests (not in refactor scope) |

Source lines analyzed (non-test): **674** (`open-store.ts` 560 + `sqlite.ts` 93 + `index.ts` 21).

## Scorecard

| Principle / Axis | Grade | Notes |
|------------------|-------|-------|
| SRP | C | `open-store.ts` mixes migrations, type defs, row mappers, transition rules, and a 230-line store factory in one file. |
| OCP | B- | Per-link `if`-chains in `turnRowToTurn` and `attachLinks` must be edited every time a link field is added (parallel-edit smell). |
| LSP | A | No subtype overrides; adapters implement interfaces faithfully. |
| ISP | B | `ConversationStore` has 11 members; cohesive but at the fat-interface threshold. |
| DIP | B+ | Driver selection is abstracted behind `SqliteDatabase`; store depends on the interface. Minor: `new Date()` / `randomUUID` are hardwired (untestable clock/id). |
| Tests | A | Behavior well covered by two test files. |

Overall: **B-**. Healthy small package; the main debt is the monolithic `open-store.ts` and three parallel-maintenance link-field code blocks that share one source of truth.

## Priority Refactorings

### P1 — Eliminate parallel link-field maintenance (OCP / duplication)
The set of `ConversationTurnLinks` fields is hand-enumerated in **four** places that must stay in lockstep:
- the `CREATE TABLE conversation_turns` column list (`open-store.ts:50-55`)
- the INSERT column list + `.run(...)` bindings in `createTurn` (`open-store.ts:429-449`)
- the null-check accumulation in `turnRowToTurn` (`open-store.ts:266-291`)
- the merge-only update builder in `attachLinks` (`open-store.ts:491-514`)

Adding one link field requires editing all four. A single ordered descriptor (link logical name -> column name) consumed by the mapper and the merge builder removes 3 of the 4 parallel edits. **Risk: medium** (touches read-back and merge semantics — must preserve the `hasLinks` "omit empty object" behavior and the merge-only "never overwrite non-null" rule). **Effort: M.** `behaviorPreserving=false` (restructures runtime data flow / SQL construction).

### P2 — Split `open-store.ts` by concern (SRP)
560 lines / 5 concerns in one file. Suggested extraction (pure file moves, no logic change):
- `migrations.ts` — `conversationStoreMigrations`, `ensureMigrationTable`, `runConversationStoreMigrations`, `listAppliedConversationStoreMigrations` (`open-store.ts:19-66,163-211`)
- `row-mappers.ts` — `ThreadRow`/`TurnRow` types + `threadRowToThread`/`turnRowToTurn` (`open-store.ts:213-306`)
- `transitions.ts` — `LEGAL_TRANSITIONS` + `assertLegalTransition` (`open-store.ts:308-325`)
- keep the store factory + public types in `open-store.ts`.

**Risk: low** (moves, not edits). **Effort: M.** `behaviorPreserving=false` (module boundary / import-graph change; flagging conservatively rather than true since it alters the public file layout the barrel re-exports from).

### P3 — Extract the `SELECT * ... WHERE turnId = ?` read-back helper (duplication)
The literal `sqlite.prepare('SELECT * FROM conversation_turns WHERE turnId = ?').get(turnId) as TurnRow` (and its `| undefined` variant) appears 5x: `open-store.ts:456,473-474,479,522-523,549`-area. Extract a `getTurnRow(turnId)` / `requireTurnRow(turnId)` local closure inside the factory. **Risk: low.** **Effort: S.** `behaviorPreserving=true` (extract identical repeated expression into a single-source helper; same SQL, same cast, same throw site preserved by `requireTurnRow`).

### P4 — Inject clock and id generator (DIP / testability)
`new Date().toISOString()` (`open-store.ts:208,361`) and `randomUUID()` (`open-store.ts:360,426`) are hardwired, making `createdAt`/`sentAt` and generated ids non-deterministic and unmockable. Optional `now?: () => string` and `genId?: (prefix) => string` on `OpenSqliteConversationStoreOptions`, defaulting to current behavior. **Risk: low-medium** (new optional seam; defaults must reproduce today's output exactly). **Effort: S.** `behaviorPreserving=false` (changes dependency wiring / adds injectable seam).

## Code Smells

| # | Location | Smell / Principle | Impact | Risk | Effort |
|---|----------|-------------------|--------|------|--------|
| 1 | `open-store.ts:266-291` | Repetitive `if (x !== null) { links.x = ...; hasLinks = true }` x6 (duplication / OCP) | Parallel edits on field add | M | M |
| 2 | `open-store.ts:491-514` | Same 6 link fields re-enumerated in merge builder (duplication / OCP) | Parallel edits; drift risk vs #1 | M | M |
| 3 | `open-store.ts:456-549` | `SELECT ... WHERE turnId = ?` read-back duplicated 5x (duplication) | Noise; single point of change wanted | L | S |
| 4 | `open-store.ts:333-553` | Store factory object literal ~220 lines (long "method"/SRP) | Hard to scan; many concerns inline | M | M |
| 5 | `open-store.ts:1-560` | One file, 5 concerns (SRP) | Navigation / ownership | M | M |
| 6 | `open-store.ts:159-161` | Magic strings `''` / `':memory:'` ephemeral test wrapped but `isEphemeralPath` only used once; `':memory:'` literal also at line 559 | Minor magic-value | L | S |
| 7 | `open-store.ts:178-180` | PRAGMA strings + `busy_timeout = 5000` magic number, executed via `.exec` not `.pragma` | Inconsistent w/ `pragma()` seam; magic number | L | S |
| 8 | `open-store.ts:407-408` | LIKE-pattern string building for projectId (`%:project:${id}:%`) — primitive/string-coupled scope querying | Brittle scope encoding knowledge leaked into store | M | M |
| 9 | `open-store.ts:547-552` | `findTurnByLink` interpolates `field` into SQL via template literal | Safe today (union-typed), but injection-shaped pattern; prefer explicit mapping | L | S |
| 10 | `open-store.ts:106-157` | `ConversationStore` interface = 11 members (ISP, at threshold) | Watch for growth; consider read/write split if it grows | L | M |
| 11 | `open-store.ts:296,298,301,261` | `as` casts from `string` row columns to literal-union TS types (unchecked narrowing) | Type-safety gap if DB CHECK drifts | L | S |
| 12 | `sqlite.ts:73-76` | `pragma()` adapter just wraps `exec("PRAGMA ...")` (thin/near-dead seam, unused by store which calls `.exec` directly) | Possibly dead method | L | S |
| 13 | `open-store.ts:450` | `createTurn` always inserts `failureReason` as literal `null` (15th bind) — dead column at insert time | Cosmetic | L | S |

## Quick Wins

- **P3 / smell #3** — extract `requireTurnRow(turnId)` read-back helper. Pure, 5 call-sites collapse. `behaviorPreserving=true`.
- **Smell #7** — name `busy_timeout` value as `const BUSY_TIMEOUT_MS = 5000` and the PRAGMA strings as constants. `behaviorPreserving=true`.
- **Smell #6** — define `const MEMORY_DB_PATH = ':memory:'` used at both `159-161` and `559`. `behaviorPreserving=true`.
- **Smell #11** — none of the `as`-narrowings need runtime change; could add a small validating cast helper but the value-preserving win is just hoisting them; leave as type note.

## Tech Debt

- **Scope-encoding coupling (smell #8):** `listThreads({ projectId })` hand-builds `:project:<id>` LIKE patterns, duplicating `agent-scope` ref-format knowledge inside the SQL layer. If scope-ref grammar changes, this silently breaks. Should delegate pattern derivation to `agent-scope` (a helper that yields match predicates). Tracked as design debt, not a mechanical refactor.
- **Dynamic-column SQL (smell #9):** `findTurnByLink` and `attachLinks` build SQL fragments from field names. Currently constrained by the `'linksRunId' | 'linksDeliveryRequestId'` union and the merge `updates[]` list, so not exploitable, but a column-name map would make it provably safe and feed the P1 descriptor refactor.
- **No clock/id seam (P4):** blocks deterministic snapshot testing of timestamps/ids.

## Safety Checklist (for the apply stage)

- Behavior-critical invariants that MUST survive any refactor:
  - `turnRowToTurn` omits the `links` object entirely when all link columns are null (`hasLinks` gate) — do not emit empty `{}`.
  - `attachLinks` is **merge-only**: never overwrites a column that is already non-null (`row.linksX === null` guard).
  - `assertLegalTransition` throws on illegal `renderState` moves; `LEGAL_TRANSITIONS` table is exact (`redacted` is terminal).
  - `updateRenderState` uses `COALESCE(?, failureReason)` so a null failureReason preserves the prior value.
  - `createOrGetThread` upsert key is `(gatewayId, conversationRef, threadRef)` with `threadRef` defaulting to `''`.
  - id prefixes `ct_` / `ctn_` and UUID dash-stripping must be preserved.
- Run `bun test` in the package after any change (covers thread + turn stores).
- Re-run `tsc --noEmit` — the `as` literal-union casts mean type errors won't surface at runtime.
- Migrations are append-only and id-gated; never edit an existing migration's `sql`.
