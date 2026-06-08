# Refactor Analysis — `packages/acp-state-store`

ANALYSIS ONLY. No source files were modified. Read-only audit of the SQLite schema + repository layer for ACP runs, input attempts, transition outbox, and workflow runtime state.

## Scope

| File | Lines | Role |
|------|------:|------|
| `src/repos/workflow-runtime-repo.ts` | 1212 | Snapshot load/save + effect-intent lifecycle for the workflow kernel |
| `src/open-store.ts` | 768 | Schema DDL, legacy migrations, store wiring |
| `src/repos/run-repo.ts` | 622 | Run CRUD, dispatch-fence, launch-claim, wrkf correlation |
| `src/repos/input-application-repo.ts` | 306 | Input application CRUD + HRC ledger reconciliation |
| `src/repos/input-attempt-repo.ts` | 294 | Input attempt creation + idempotency/fingerprint |
| `src/types.ts` | 234 | DTOs + error classes |
| `src/repos/input-queue-repo.ts` | 241 | Input queue CRUD + dispatch selection |
| `src/repos/transition-outbox-repo.ts` | 212 | Transition outbox lease/deliver |
| `src/repos/input-admission-repo.ts` | 138 | Input admission CRUD |
| `src/sqlite.ts` | 93 | Bun/better-sqlite3 driver abstraction |
| `src/index.ts` | 37 | Public barrel |
| `src/repos/shared.ts` | 36 | Mapping helpers + `RepoContext` |
| `src/repos/session-admission-sequence-repo.ts` | 33 | Per-session sequence reservation |

Total source lines analyzed: **4226**.

## Scorecard

| Dimension | Grade | Notes |
|-----------|:-----:|-------|
| SRP | C | `workflow-runtime-repo.ts` (1212 LOC) and `open-store.ts` (768 LOC) each mix many concerns; per-table write/map blocks are mechanically repeated. |
| OCP | B | Ledger-status and effect-state handling use small if-chains; tolerable but type-keyed. |
| LSP | A | No subtype substitution issues; `SqliteDatabase` abstraction is consistently honored. |
| ISP | B | `AcpStateStore` exposes 8 repos + helpers; `SqliteDatabase` is reasonable. No egregious fat interfaces. |
| DIP | B- | Repos depend on injected `RepoContext`, good. But `openAcpStateStore` hardcodes `new XxxRepo(...)` for all 8 repos and `new Database(...)`. |
| DRY | C- | Massive duplication: full column lists repeated across SELECTs; `map*Row`/`write*` pairs follow identical row↔record shape with hand-written conditional spreads; effect-intent `mark*` methods are near-copies. |
| Readability | B | Naming is clear; long methods (`loadSnapshot`, `saveSnapshot`, `updateRun`, migrations) hurt scanability. |

Overall: **B-**. Functionally coherent and well-typed, but heavy mechanical duplication and two oversized files dominate the debt.

## Priority Refactorings

### P1 — Extract the run SELECT column list into a shared constant (`run-repo.ts`)
The identical ~22-column `SELECT run_id, scope_ref, ...` block is hand-copied in `getRun` (357), `listRuns` (391), `listRunsByStatus` (425), and `listRunsForSession` (460). A single `RUN_SELECT_COLUMNS`/`runSelectSql()` constant (mirroring the `selectSql()` pattern already used in `input-application-repo.ts:169` and `input-queue-repo.ts:220`) removes four copies and the drift risk. Pure extraction of a string constant.
- Principle: DRY / SRP. Risk: low. Effort: low. Behavior-preserving.

### P1 — Collapse the four effect-intent `mark*` methods (`workflow-runtime-repo.ts:460-523`)
`markEffectIntentDelivered`, `markEffectIntentFailed`, and `markEffectIntentUnsupported` are structurally identical: same SELECT, same `state === target` short-circuit, same UPDATE, differing only in target state and the lifecycle-event payload. Extract a private `transitionEffectIntent(effectId, targetState, eventInput)` helper and have the three public methods delegate. `leaseEffectIntent` shares the same SELECT shape. Reduces ~60 lines of copy. Behavior-preserving if the helper reproduces each branch's exact event payload.
- Principle: DRY / OCP. Risk: low-medium (must preserve per-state event payloads, esp. `unsupported`'s errorCode/message). Effort: medium.

### P2 — Split `workflow-runtime-repo.ts` snapshot read/write into mappers (`workflow-runtime-repo.ts`)
`loadSnapshot` (525-856, ~330 lines) and `saveSnapshot`+`write*` (858-1211) hand-write a row↔record mapping for 14 tables. Each `map`/`write` pair shares the same column set already declared in the `*Row` types at the top of the file. Extract per-entity codec modules (e.g. `evidenceCodec`, `eventCodec`) or at least split the file into `workflow-snapshot-load.ts` / `workflow-snapshot-write.ts`. This is the single largest SRP offender in the package.
- Principle: SRP / DRY. Risk: medium (large surface; the conditional-spread `...(x !== null ? {k} : {})` blocks must be reproduced exactly to preserve optional-field omission semantics). Effort: high.

### P2 — Extract the shared optional-field spread idiom (`workflow-runtime-repo.ts`, `run-repo.ts`, `input-*-repo.ts`)
The pattern `...(row.x !== null ? { camelX: row.x } : {})` appears well over 100 times across the package. A typed helper such as `optionalField(key, value)` or `assignDefined(target, key, value)` would centralize the null→omit convention. Note `shared.ts` already exports `toOptionalString`/`toOptionalNumber`/`toOptionalBooleanFromInt` but they are barely used (only `transition-outbox-repo.ts` uses `toOptionalString`). Adopting them consistently is a behavior-preserving cleanup.
- Principle: DRY. Risk: low (per call site), but volume is high. Effort: medium.

### P2 — Decompose `updateRun` (`run-repo.ts:493-550`)
The single `next` object literal chains ten `...('field' in patch ? (patch.field === undefined ? {} : { field: patch.field }) : {})` ternaries — a long method with a repeated three-level conditional. Extract a `applyPatchField(target, patch, key)` helper or a small loop over a field list. The `'field' in patch` + `=== undefined` distinction (explicit-undefined vs absent) must be preserved.
- Principle: DRY / readability. Risk: medium (the in-operator-vs-undefined semantics are subtle). Effort: medium.

### P3 — Factor the legacy-migration `addColumnIfMissing` batches (`open-store.ts:408-519`)
`migrateRunsActorColumns`, `migrateInputAttemptsActorColumns`, `migrateTransitionOutboxActorColumns` each add the same three actor columns and run a near-identical `UPDATE ... CASE WHEN '' THEN 'system'/'acp-local'` backfill. Extract `addActorColumns(sqlite, table)` + `backfillActorDefaults(sqlite, table)` helpers. The input-attempts variant has the extra legacy `actor_agent_id` branch and must keep its early-return.
- Principle: DRY. Risk: medium (DDL/migration correctness; idempotency must hold). Effort: medium.

### P3 — Replace duplicated `runs` DDL with one source (`open-store.ts:39-63` vs `540-564`)
The full `CREATE TABLE runs (...)` body is written twice: once in `initializeSchema` and again verbatim inside `rebuildRunsForQueuedStatus`. They must stay in sync by hand. Hoist the column body to a single constant referenced by both. Same risk class as any DDL change.
- Principle: DRY. Risk: medium. Effort: low-medium.

### P3 — Wire repos via a factory map, not 8 hardcoded `new` calls (`open-store.ts:749-765`)
`openAcpStateStore` directly constructs each repo. For DIP/testability a small registry or factory list keyed by name would decouple wiring. Low payoff relative to risk; listed for completeness.
- Principle: DIP. Risk: medium (changes the construction/assembly of the public store object). Effort: medium.

## Code Smells

| Location | Smell | Impact |
|----------|-------|--------|
| `workflow-runtime-repo.ts:525-856` | Long method (`loadSnapshot`, ~330 lines) | Hard to read/test; 14 inline mappers. |
| `workflow-runtime-repo.ts:278-395` | Long method (`appendEffectLifecycleEvent`, ~117 lines) with a 28-positional-arg `.run(...)` | High error surface on column order. |
| `workflow-runtime-repo.ts:460-523` | Duplicated `mark*` methods | 3 near-identical bodies. |
| `run-repo.ts:357,391,425,460` | Duplicated 22-column SELECT (×4) | Drift risk; verbosity. |
| `run-repo.ts:216-271`, `566-612` | 23-positional-arg INSERT/UPDATE | Column/value misalignment risk. |
| `run-repo.ts:493-545` | Long method + repeated conditional spread (`updateRun`) | Subtle `in`/`undefined` logic repeated ×10. |
| `open-store.ts:39-375` | 337-line DDL string literal | One function holds the entire schema. |
| `open-store.ts:529-714` | Two large hand-written table-rebuild SQL blocks | DDL duplicated against `initializeSchema`. |
| `input-attempt-repo.ts:150-220` | Branch duplication (legacy vs current INSERT) | Two ~35-line INSERT blocks differ by one column. |
| `input-application-repo.ts:187-271` | Type-keyed if/chain on `ledgerStatus` string | OCP: new ledger statuses require editing the chain. |
| Whole package | `...(x !== null ? {k:x} : {})` idiom ×100+ | Pervasive boilerplate; `shared.ts` helpers underused. |
| `run-repo.ts:200`, `input-attempt-repo.ts:140`, `input-application-repo.ts:62`, `input-queue-repo.ts:59` | Magic id-gen `randomUUID().replace(/-/g,'').slice(0,12)` duplicated with literal `12` | Primitive obsession; one `shortId(prefix)` helper would dedup. |
| `run-repo.ts:197`, `createOrGetRun:295`, `transition-outbox-repo.ts:60` | Repeated literal `{ kind: 'system', id: 'acp-local' }` default actor | Magic default scattered; should be a named const. |
| `input-queue-repo.ts:115,130` | Magic limits `50`, `200` as defaults | Unnamed tuning constants. |
| `input-admission-repo.ts:115-119` | Nested ternary for `current_state_json` | Deep conditional; hard to read. |
| `input-application-repo.ts:201` | `input.ledger.status as string` cast | Type narrowing lost; primitive obsession. |

## Quick Wins (low-risk, behavior-preserving)

1. Add `RUN_SELECT_COLUMNS` constant in `run-repo.ts` and reuse across the 4 list/get queries (mirrors existing `selectSql()` in sibling repos). [P1]
2. Introduce a `shortId(prefix: string)` helper for the `randomUUID().replace(/-/g,'').slice(0,12)` pattern used in 4 repos; replace the literal `12` with a named `SHORT_ID_LEN`.
3. Introduce a `DEFAULT_SYSTEM_ACTOR` const for the repeated `{ kind: 'system', id: 'acp-local' }` literal (run-repo ×2, transition-outbox, input-attempt `normalizeActorInput`).
4. Name the dispatch limit magic numbers (`50`, `200`) in `input-queue-repo.ts` as constants.
5. Adopt the existing `toOptionalString`/`toOptionalNumber` helpers from `shared.ts` at obvious null→undefined sites instead of inline ternaries.
6. Hoist the `runs` `CREATE TABLE` column body to one shared template literal referenced by both `initializeSchema` and `rebuildRunsForQueuedStatus`.

## Tech Debt (larger, not behavior-preserving)

- **Snapshot codec extraction** (`workflow-runtime-repo.ts`): the load/save halves should become per-entity codecs or split files. Largest structural debt; touches optional-field omission semantics so it is not purely mechanical.
- **Effect-intent lifecycle consolidation**: collapsing `mark*`/`lease` requires preserving per-state event payloads (notably `unsupported` carries `errorCode`/`errorMessage`).
- **Migration helper extraction** (`open-store.ts`): the three actor-column migrators and the two table-rebuilds carry real DDL/idempotency risk; refactor only with the migration tests green.
- **`updateRun` patch application**: the `'field' in patch` vs explicit-`undefined` distinction is load-bearing for partial updates; any generalization must preserve it exactly.
- **Ledger-status dispatch** (`input-application-repo.ts`): the string-keyed if-chain could become a status→outcome table, but that changes control flow and error mapping.

## Safety Checklist (for the apply stage)

- [ ] `bun test` (package has `test/` dir + `bun test` script) passes before and after each change.
- [ ] `tsc --noEmit` (typecheck script) clean — the package relies heavily on exact optional-property typing (`exactOptionalPropertyTypes`-style spreads).
- [ ] For any SELECT-column dedup: confirm the new constant reproduces column ORDER exactly (rows are consumed positionally via typed casts, not by name in `.run(...)`, but SELECT→object mapping is by name — safe; still verify the column SET matches).
- [ ] For any INSERT/UPDATE `.run(...)` change: positional arg order must remain byte-identical to the `?` placeholders.
- [ ] Migration refactors: run against a legacy DB fixture (with `actor_agent_id`, pre-`queued` status check, NOT-NULL `run_id`) to confirm idempotent re-run.
- [ ] Effect-intent consolidation: assert the emitted `workflow_events` rows (type, deliveryResult, errorCode, errorMessage) are unchanged per state.
- [ ] Preserve transaction boundaries — several methods wrap logic in `sqlite.transaction(...)`; do not extract helpers across that boundary.
