# Refactor Analysis — `packages/acp-jobs-store`

ANALYSIS ONLY. No source was modified. Generated 2026-06-07.

## Scope

Non-test TypeScript source in `packages/acp-jobs-store/src` (dist/, node_modules/, `__tests__/` excluded).

| File | Lines | Role |
|---|---|---|
| `open-store.ts` | 2159 | SQLite-backed `JobsStore`: schema/migrations, type defs, row<->record mappers, every CRUD/claim/event primitive (factory closure) |
| `flow-validation.ts` | 682 | Structural validation of `JobFlow` (steps, exec, expectations, branches, acyclicity) |
| `scheduler.ts` | 336 | `tickJobsScheduler` orchestration: claim due jobs, drain event inbox, dispatch/advance |
| `cron.ts` | 169 | Minimal 5-field cron parser + `nextFireAfter` |
| `sqlite.ts` | 93 | Bun/better-sqlite3 driver shim behind `SqliteDatabase` interface |
| `index.ts` | 70 | Barrel re-exports |
| `flow-status.ts` | 21 | `mapJobRunStatusForFlowResponse` status mapping |

**Total source analyzed: 3530 lines.**

---

## Scorecard

| Principle / Dimension | Grade | Notes |
|---|---|---|
| SRP | D | `open-store.ts` is a 2159-line god-module mixing schema DDL, type definitions, row mappers, and ~30 store operations in one closure. `tickJobsScheduler` mixes claim + drain + dispatch + flow-advance + inflight-sweep. |
| OCP | C | Generally data-driven, but `mapJobRunStatusForFlowResponse` and `resolveTrigger`/`scheduleColumnsForTrigger` branch on kind; new trigger kinds require touching several `if (kind === 'schedule')` sites. |
| LSP | A | No inheritance hierarchies with weakened overrides; driver shim implements the interface faithfully. |
| ISP | D | `JobsStore` is a ~50-member fat interface that duplicates every operation as BOTH a flat method and a grouped namespace (`createJob` + `jobs.create`, etc.). Consumers cannot depend on a narrow slice. |
| DIP | B | Driver is injected behind `SqliteDatabase` interface (good). But the store factory hardcodes `new Database(...)`, `randomUUID`, and `Date.now()`/`new Date()` throughout — time and id generation are not injectable, hurting testability/determinism. |
| Duplication | C | INSERT/UPDATE column lists for jobs and job_runs are repeated between insert and update; row->record mappers repeat the `x !== null ? {k:x} : {}` idiom ~60 times; `actor ?? {kind:'system', id:'scheduler'}` built twice in `claimDueJobs`; near-identical claim loops (`claimDueJobRuns`, `claimPendingInboxEvents`). |
| Magic numbers / primitives | C | Inline `randomUUID().replace(/-/g,'').slice(0,12)` id format repeated; default limits (`100`, `50`), lease ms, `64*1024*1024`, id-prefix strings literal at call sites. |

---

## Priority Refactorings

### P1 — Split `open-store.ts` (2159 lines) into cohesive modules (SRP)
**Location:** `open-store.ts:1-2159`
**Smell:** God module. Four distinct concerns co-resident: (a) migration DDL `jobsStoreMigrations` (`410-640`), (b) ~30 exported type/record definitions (`11-408`), (c) row->record mappers + row fetch helpers (`745-981`), (d) the `openSqliteJobsStore` factory with all operations (`1117-2155`).
**Impact:** Hard to navigate, review, and test; every change to any primitive reloads the whole file. Mappers and migrations are pure and trivially extractable.
**Suggested move:** `migrations.ts` (the migration array + `runJobsStoreMigrations`/`listAppliedJobsStoreMigrations`), `records.ts`/`mappers.ts` (the `toJobRecord`/`toJobRunRecord`/`toJobStepRunRecord`/`toInboxEventRecord`/`toEventJobMatchRecord` + `rowToActor`/`parseJsonRecord` helpers), `types.ts` (the exported interfaces). Keep the factory thin.
**behaviorPreserving:** false (cross-module moves change the module graph / export surface and require import rewiring; safe but not provably behavior-neutral here).
**Risk:** Med · **Effort:** Med

### P2 — Collapse the dual flat-method + namespace surface on `JobsStore` (ISP / duplication)
**Location:** `open-store.ts:646-743` (interface) and `2085-2152` (literal)
**Smell:** Fat interface. Every operation is declared twice — flat (`createJob`, `appendJobRun`, `claimDueJobRuns`, `insertInboxEvent`, …) and grouped (`jobs.create`, `jobRuns.append`, `jobRuns.claimDueRuns`, `eventInbox.insert`, …) — wiring the SAME closures. ~50 members; consumers can't depend on a sub-slice.
**Impact:** Doubles the interface, the literal, and the maintenance cost; every new op must be added in 2 places consistently.
**Suggested:** Pick one surface (grouped namespaces) and derive the other only if back-compat is required, or drop the flat aliases. This touches the public API of the package.
**behaviorPreserving:** false (removes/changes exported members consumed by other packages).
**Risk:** Med · **Effort:** Med

### P3 — Decompose `tickJobsScheduler` (`scheduler.ts:190-311`, ~120 lines) (SRP / long method)
**Location:** `scheduler.ts:190-311`
**Smell:** Long method with five sequential responsibilities: claim schedule jobs, conditionally drain the event inbox, build `allClaimed`, run the per-entry flow/dispatch branch (with two near-identical try/catch fail-update blocks at `224-237`, `269-279`, `294-306`), then sweep inflight flow runs. The failed-run `updateJobRun({status:'failed', errorCode, errorMessage, completedAt, leaseOwner:null, leaseExpiresAt:null})` shape is written three times.
**Impact:** Dense control flow; the triplicated failure-update is a copy-paste hazard.
**Suggested:** Extract `failJobRun(store, jobRunId, errorCode, error, now)` helper and `dispatchEntry`/`advanceEntry` helpers; have `tick` orchestrate.
**behaviorPreserving:** false (extracting the dispatch/advance helpers reorders nothing but the failure-helper changes call sites; treat as behavior-affecting since error/async paths are involved — verify with the scheduler tests).
**Risk:** Med · **Effort:** Med

### P4 — Extract the shared "claim candidate then conditional-UPDATE" loop (duplication / DIP)
**Location:** `open-store.ts:1642-1703` (`claimDueJobRuns`), `1861-1906` (`claimPendingInboxEvents`), and the inline variant in `claimDueJobs` (`1739-1819`)
**Smell:** Three lease-claim transactions share the identical structure: SELECT candidate ids ordered, loop, run a guarded conditional UPDATE, skip when `changes === 0`, re-fetch row, collect. The WHERE-guard `status='pending' OR (status='leased'/'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))` is duplicated verbatim in SELECT and UPDATE within each.
**Impact:** Lease semantics live in 3+ places; a fix to the expiry predicate must be made everywhere.
**Suggested:** A `claimWithLease({ table, candidateSql, updateSql, mapRow })` helper, or at minimum hoist the lease-predicate SQL fragment to a named constant.
**behaviorPreserving:** false (SQL string consolidation across operations risks subtle predicate drift; not provably identical without test coverage).
**Risk:** Med · **Effort:** Med

### P5 — Dedup the row->record mapper boilerplate (duplication)
**Location:** `open-store.ts:805-940` (`rowToActor`, `toJobRecord`, `toInboxEventRecord`, `toEventJobMatchRecord`, `toJobRunRecord`, `toJobStepRunRecord`)
**Smell:** The `...(row.x !== null ? { camelKey: row.x } : {})` conditional-spread idiom appears ~60 times across the mappers. `rowToActor` is invoked for jobs and job_runs identically.
**Impact:** Verbose, error-prone (easy to mismatch a key); a single `pickDefined`/`optional(key, value)` helper would shrink each mapper by ~40%.
**Suggested:** Add a tiny `optional<K extends string>(k: K, v: T | null): {} | Record<K, T>` helper and route the conditional spreads through it.
**behaviorPreserving:** false (a generic helper changes how absent keys are produced; equivalent in intent but should be validated against the record-shape tests — `undefined` vs absent-key distinctions matter for `exactOptionalPropertyTypes`).
**Risk:** Low · **Effort:** Med

---

## Code Smells

| # | Location | Smell | Principle | Impact | behaviorPreserving |
|---|---|---|---|---|---|
| 1 | `open-store.ts:1127, 1331` | Inline id format `\`job_${randomUUID().replace(/-/g,'').slice(0,12)}\`` / `jrun_…` duplicated | Magic / DRY | Two id-gen sites drift independently | true (extract identical `newId(prefix)` helper) |
| 2 | `open-store.ts:1805-1807` | `{ kind:'system', id:'scheduler' }` literal built twice in one call | Duplication / magic | Default actor inlined twice | true (hoist to a local const) |
| 3 | `flow-validation.ts:59` | `const maxExecOutputBytes = 64 * 1024 * 1024` is the only named constant; `cron.ts` iteration cap `60*24*366*5` (`cron.ts:159`) is inline-only | Magic number | Cron `maxIterations` undocumented | true (name the cron cap constant) |
| 4 | `scheduler.ts:55` | `DEFAULT_EVENT_LEASE_MS` good; but claim limits `100`/`50` are literal at `open-store.ts:1715,1741,1862` and `scheduler.ts:206-207` | Magic number | Default limits scattered | true (name the limits) |
| 5 | `open-store.ts:1196-1225` | `listJobs` duplicates the full SELECT body for the projectId/no-projectId branches | Duplication | Two near-identical query blocks | false (combining requires conditional WHERE building — query-shape change) |
| 6 | `open-store.ts:1134-1191, 1272-1316, 1335-1390, 1429-1469` | Job/job_run INSERT and UPDATE repeat the same column lists/binding order | Duplication / primitive obsession | Column-order coupling between insert & update is fragile | false (consolidation alters statements) |
| 7 | `scheduler.ts:91-188` | `drainEventInbox` is ~98 lines with nested try/catch and ≥4 levels of nesting (event loop → job loop → evaluation try → cooldown if) | Long method / deep nesting | Hard to follow; per-job and per-event error isolation interleaved | false (extracting `evaluateAndMint(job,event)` changes structure around error handling) |
| 8 | `open-store.ts:1556-1607`, `1415-1477` | Long sequences of `'field' in patch ? (patch.x ?? null) : existing.col` coalescing (10+ per fn) | Long method / primitive obsession | `updateJobStepRun`/`updateJobRun` patch-merge is verbose, repetitive | false (a generic patch-merge helper changes null/undefined handling) |
| 9 | `flow-validation.ts` whole file | Validator passes a mutable `errors[]` accumulator through ~12 functions (`addError` side-effects) | Design / data-flow | Works, but every fn takes `errors` as a param; could return error lists | false (changes function signatures and aggregation) |
| 10 | `open-store.ts:2145-2148` | `runInTransaction` casts `store as JobsStore` (the literal is still being built) | Type smell | Self-reference via cast; `satisfies` can't see the forward use | false (restructuring the closure exposure) |
| 11 | `cron.ts:145-169` | `nextFireAfter` loops minute-by-minute up to ~2.6M iterations (`60*24*366*5`) | Efficiency | Worst-case (impossible cron) walks 5 years of minutes before returning null | false (algorithmic change) |
| 12 | `flow-validation.ts:464-484, 531-542` | Branch-target traversal logic (`kind==='exec' && isRecord(branches)` → iterate exitCode + default) duplicated between `validateBranchTargets` and `validatePhaseAcyclic` | Duplication | Two copies of the same edge-extraction walk | false (extracting a shared `forEachBranchTarget` changes both call sites) |
| 13 | `open-store.ts:35-115` vs `122-218` | Row types (`JobRow`, `JobRunRow`, …) and Record types are parallel near-mirror declarations | Primitive obsession / duplication | snake_case row + camelCase record kept in lockstep by hand | false (codegen/derivation is a structural change) |

---

## Quick Wins (behavior-preserving, low risk)

1. **Extract `newId(prefix: string)`** for the duplicated `${prefix}_${randomUUID().replace(/-/g,'').slice(0,12)}` (used at `open-store.ts:1127` and `1331`). Pure extract of identical logic.
2. **Hoist the scheduler default actor** `{ kind:'system', id:'scheduler' }` to a single local in `claimDueJobs` (`open-store.ts:1805-1807`) — built twice in one expression.
3. **Name the cron iteration cap** `MAX_FIRE_SCAN_MINUTES = 60 * 24 * 366 * 5` with a comment (`cron.ts:159`) — replace magic with same-value named const.
4. **Name the default claim limits** (`100`, `50`) as module constants (`open-store.ts:1715, 1741, 1862`; `scheduler.ts:206-207`).
5. **Introduce `optional(key, value)` mapper helper** and apply mechanically to the ~60 conditional spreads — net same output, far less noise. (Validate against record-shape tests; flagged as Med elsewhere because of `exactOptionalPropertyTypes`, but the per-call substitution is itself mechanical.)

---

## Tech Debt

- **Time & identity are non-injectable.** `Date.now()`/`new Date().toISOString()` and `randomUUID()` are called directly throughout `open-store.ts`. Tests must pass `now`/explicit ids in many paths but the factory still reaches for ambient clock in `updateJob`, `archiveJob`, `appendJobRun`, `updateJobRun`, `insertJobStepRuns`, `mark*`, etc. A `clock`/`ids` collaborator (DIP) would make every op deterministic.
- **Migration `005` rebuilds the whole `jobs` table** (`open-store.ts:540-591`) — heavy, irreversible, and the largest single risk in the file; worth isolating and snapshot-testing in its own module.
- **Dual public surface** (flat + grouped) is a back-compat tax; until a consumer audit confirms who uses which, P2 is blocked on cross-package usage analysis.
- **`source`/`resolvedInput`/`payload` are `Record<string, unknown>`** end to end — no schema on the provenance/snapshot blobs; `parseJsonRecord` only guarantees "is an object".

---

## Safety Checklist (before any apply stage)

- [ ] Run `packages/acp-jobs-store/src/__tests__/*` (jobs-store, job-runs-store, flow-validation, scheduler-*, event-jobs) — these cover claim, catch-up, flow resume, hourly-minute-zero, event minting.
- [ ] For any mapper change (P5/Quick-win 5): confirm `exactOptionalPropertyTypes` behavior — absent key vs `undefined` value must stay absent in records.
- [ ] For P1 module split: rebuild the package and re-run the barrel (`index.ts`) export consumers in dependent packages (acp-server) — no export should disappear.
- [ ] For P2/P4 (public surface + claim SQL): grep dependents for `.jobs.`, `.jobRuns.`, `.eventInbox.`, and flat `createJob(`/`claimDueJobRuns(` usage before removing any alias; diff generated SQL strings byte-for-byte.
- [ ] For P3 scheduler decomposition: assert the failed-run update payload (status/errorCode/leaseOwner:null/leaseExpiresAt:null/completedAt) is byte-identical across all three former sites.
- [ ] Do NOT touch migration SQL strings as part of a "refactor"; migrations are append-only history.
