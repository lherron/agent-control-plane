# Refactor analysis: `acp-jobs-store`

Package type profile: **data** (SQLite-backed durable store + a thin scheduler/validation layer). Matching swaps considered: [T27] normalize, [T13] push invariant to constraint, [T24] batch N+1. Concurrency swaps ([T31]/[T32]) are also relevant because the claim/lease loops are check-then-act sequences — assessed below.

Files read in full: `src/index.ts`, `src/cron.ts`, `src/flow-status.ts`, `src/flow-validation.ts`, `src/open-store.ts` (2207 lines, both pages), `src/scheduler.ts`, `src/sqlite.ts`, `package.json`. Tests surveyed (not modified): the 9 files under `src/__tests__/` plus `test/smoke.test.ts` (~50 tests).

## Summary

The package is in good structural shape. The boundary is large but the breadth is mostly load-bearing: the namespaced facade (`store.jobs.*`, `store.jobStepRuns.*`, `store.eventInbox.*`) AND the flat facade (`store.createJob`, `store.updateJobRun`, …) are BOTH consumed by `acp-server` in non-test code, so the apparent duplication is not dead structure. The highest-value safe wins are de-abstraction of genuinely unused exports (the `Sqlite*` re-export cluster, `assertValidJobFlow`, the `ScheduledRun` alias) and DRYing two structurally identical claim-loops and the per-column `?? existing` coalesce blocks. The interesting *behavioral* notes (the `skipped -> failed` status flattening, the `created_at = baseTime + index` ordering hack, the catch-then-`template_error` swallow) are flagged as deferred because they change observable output or error classification.

Most magic-number / primitive-obsession smells are already addressed (named constants `MAX_FIRE_SCAN_MINUTES`, `DEFAULT_CLAIM_LIMIT`, `DEFAULT_EVENT_LEASE_MS`; `JOB_SLUG_REGEX` extracted; `pickNullable` already factors the nullable-patch idiom). I did not invent extraction work where it was already done.

## Public boundary — assessed FIRST

`src/index.ts` re-exports from six modules. Verdict: **needs-care** (sound core, a leaky/over-wide tail).

What the boundary exposes and how it is actually used (verified by grep across `packages/`/`apps/`, excluding `dist/` and the package's own `src/`):

- **Used, keep:** `createInMemoryJobsStore`, `openSqliteJobsStore`, `createJobsScheduler`, `tickJobsScheduler`, `mapJobRunStatusForFlowResponse`, `validateJobFlow`, `validateJobFlowJob`, `isValidCron`, `nextFireAfter`, `isValidJobSlug`, and many `type` exports (`JobsStore`, `JobRecord`, `JobRunRecord`, `EvaluateEventJob`, `JobFlowValidationResult`, etc.). The dual flat+namespaced `JobsStore` methods are both consumed (flat: `createJob`/`getJob`/`updateJob`/`listJobs`/`listJobRuns`/`updateJobRun`; namespaced: `jobStepRuns.getById`/`insertMany`/`listByJobRun`). This is a deliberate dual API — **contraindication for collapse**.
- **Exported but no external consumer (leaf-removable):**
  - `assertValidJobFlow` (`flow-validation.ts:672`) — zero callers anywhere (not even tests).
  - `SqliteDatabase` default export + `JobsSqliteDatabase`, `JobsSqliteDatabaseConstructor`, `JobsSqliteRunResult`, `JobsSqliteStatement` type aliases (`index.ts:64-70`) — no importer outside the package; `JobsStore.sqlite` is already typed as `SqliteDatabase` internally. (The `SqliteDatabase` matches elsewhere belong to `acp-interface-store`'s own copy.)
  - `ScheduledRun` (alias of `JobRunRecord`, `scheduler.ts:53`) — only re-exported, never imported.
  - `migrations`-related (`jobsStoreMigrations`, `runJobsStoreMigrations`, `listAppliedJobsStoreMigrations`, `JobsStoreMigration`) — keep (migration tooling surface).

Because `acp-jobs-store` is NOT a leaf package (it has a live consumer, `acp-server`), Expand/Contract [M02] applies to any contract change. But removing exports that have **zero** consumers is a safe contract narrowing that needs no migration window — the compiler proves no caller exists.

## Findings by mechanism (outside-in)

### B. Boundary

#### F1 — Remove unused `Sqlite*` re-export cluster [T16 collapse premature abstraction]
- Location: `packages/acp-jobs-store/src/index.ts:64-70`; the underlying `src/sqlite.ts` default + interfaces stay (used internally by `open-store.ts`).
- Mechanism repaired: premature public surface — a low-level driver type set was lifted to the boundary in case a consumer wanted to BYO database; that variation never materialized.
- Direction: remove (narrow the boundary).
- Preservation rung: public-contract narrowing with a compiler-proof of zero external importers (grep confirmed). Behavior of `JobsStore` unchanged.
- Falsifiable signal: after deleting these export lines, repo-wide `tsc -b` still passes and `bun test` is green.
- Risk: Low. API-impact: public-surface (removes names, but unconsumed). Effort: XS.
- Contraindication: if any out-of-repo consumer imports `JobsSqliteDatabase`, this breaks them — but none exist in this monorepo. Listed as deferred per the gate because it is public-surface.

#### F2 — Remove unused `assertValidJobFlow` [T16 / leaf-removal]
- Location: `packages/acp-jobs-store/src/flow-validation.ts:672-680`, export wiring `src/index.ts:44`.
- Mechanism repaired: dead public helper; consumers call `validateJobFlow`/`validateJobFlowJob` and handle the result themselves. The throwing `asserts`-variant is unused.
- Direction: remove.
- Preservation rung: compiler-proof unused (zero callers including tests).
- Falsifiable signal: delete + `tsc`/`bun test` green.
- Risk: Low. API-impact: public-surface. Effort: XS.
- Contraindication: it is a documented assertion helper; keep if there is intent to use it from `acp-server` flow validation soon. Defer (public-surface).

#### F3 — Remove unused `ScheduledRun` alias [T16]
- Location: `packages/acp-jobs-store/src/scheduler.ts:53`, export `src/index.ts:60`.
- Mechanism repaired: a one-line type alias (`= JobRunRecord`) added for naming symmetry but never imported; internal `tickJobsScheduler` uses it but could use `JobRunRecord` directly.
- Direction: remove from the public export (optionally keep the internal alias).
- Preservation rung: type-only, no runtime effect.
- Falsifiable signal: `tsc` green after removing from `index.ts`.
- Risk: Low. API-impact: public-surface. Effort: XS.
- Contraindication: trivial naming nicety; low value either way. Defer (public-surface).

### C. Seams & structure (internal-only, behavior-preserving)

#### F4 — Extract the shared claim-and-lease loop [T15 extract missing abstraction]
- Location: `packages/acp-jobs-store/src/open-store.ts:1687-1748` (`claimDueJobRuns`) and `src/open-store.ts:1908-1953` (`claimPendingInboxEvents`).
- Mechanism repaired: duplicated intent. Both implement the identical optimistic-claim shape: `SELECT candidate ids` -> per-candidate conditional `UPDATE ... WHERE <still-claimable>` -> `if changes===0 continue` -> re-read row -> push. Two copies of the same check-then-act-under-transaction algorithm differ only in table/columns/projection.
- Direction: relocate/isolate into one private helper (e.g. `claimWithLease({ selectSql, claimSql, reread, params })`) that both call.
- Preservation rung: internal-only; identical SQL strings and transaction boundaries preserved (the helper just parameterizes them). No row/field-set change.
- Falsifiable signal: existing `scheduler-tick`, `scheduler-catch-up`, `event-jobs` tests stay green; the two methods return byte-identical records.
- Risk: Med (touches the concurrency-critical claim path; easy to subtly change a WHERE clause). API-impact: internal-only. Effort: M.
- Contraindication: the two WHERE predicates are NOT identical (`triggered_at <= ?` extra clause on job_runs); the helper must keep them distinct, so the dedup is of the *control flow*, not the SQL. If parameterizing makes the SQL harder to read, leave as-is — the duplication is partly load-bearing clarity. Given concurrency sensitivity, treat as Med and gate behind characterization tests.

#### F5 — Collapse the per-column `?? existing` coalesce blocks via a row-patch helper [T15 / T21 parameter object]
- Location: `packages/acp-jobs-store/src/open-store.ts` `updateJob` (1258-1344), `updateJobRun` (1441-1510), `updateJobStepRun` (1577-1660). `pickNullable` already factors the *nullable* case; the non-nullable `patch.x ?? existing.col` lines are still hand-rolled per column.
- Mechanism repaired: primitive obsession / repeated coalesce idiom across three large update functions; each new column adds another `patch.foo ?? existing.foo` line in two places (the local + the `.run(...)` arg list).
- Direction: extract a small `coalesce(value, existing)` companion to `pickNullable`, or a column-map builder; keep the explicit SQL.
- Preservation rung: internal-only; the resolved value per column is identical.
- Falsifiable signal: `jobs-store`, `job-runs-store` update tests green; same UPDATE arg vector.
- Risk: Low. API-impact: internal-only. Effort: S.
- Contraindication: these UPDATE statements are deliberately explicit (full-row writes); over-abstracting into a generic column map could obscure which columns are written and trip readability. Apply only the small `coalesce` helper, not a dynamic SQL builder.

#### F6 — `requireSchedule` throws inside a column-deriver [note only]
- Location: `packages/acp-jobs-store/src/open-store.ts:1012-1018`, called from `scheduleColumnsForTrigger` (1099) on both create and update paths.
- Mechanism: a validation throw is buried in a "derive columns" function. It is correct (invalid cron must reject), but the error-raising responsibility is mixed into a pure-looking deriver. Low value; documented for completeness. No change recommended unless F4/F5 work is already opening these functions.
- Direction: none (leave). Risk: n/a. API-impact: internal-only.

### D. Invariants

#### F7 — `mapJobRunStatusForFlowResponse` flattens `skipped` into `failed` [T17 partial->total / behavior]
- Location: `packages/acp-jobs-store/src/flow-status.ts:18-19`.
- Mechanism: the response mapper folds the distinct `skipped` run status into `failed`. The `switch` is already total over `JobRunStatus` (good — no default arm), but the *semantic* collapse loses information at the API boundary.
- Direction: would require widening `FlowJobRunResponseStatus` to carry `skipped` (or `cancelled`) — that is a **redesign of the response contract**, not a refactor.
- Preservation rung: NOT behavior-preserving; changes the wire status consumers see.
- Risk: High. API-impact: public-surface. Effort: M (needs consumer + UI alignment).
- Contraindication: the flattening may be intentional (UI renders 4 buckets). Do NOT auto-apply; raise with the owner.

### E. Quality

#### F8 — `created_at = baseTime + index` ordering hack in `insertJobStepRuns` [T13 push invariant to constraint — defer]
- Location: `packages/acp-jobs-store/src/open-store.ts:1517-1520`.
- Mechanism: insertion order is encoded by spacing `created_at` 1 ms per step so `listByJobRun`'s `ORDER BY created_at` reproduces it. This is data-modeling by side effect; the real invariant ("steps list in insertion order") would be better carried by an explicit ordinal column (T13/T27). It also assumes step counts/timing won't collide.
- Direction: add an ordinal column (schema migration) — changes stored data shape.
- Preservation rung: NOT a pure refactor (new column / migration / changed ORDER BY).
- Risk: High (migration + ordering contract). API-impact: internal-only storage, but observable via `listJobStepRuns` ordering. Effort: M.
- Contraindication: current scheme works for realistic step counts; a migration is only worth it if step-ordering bugs appear. Defer.

#### F9 — Catch-all `template_error` swallow in `drainEventInbox` [note — leave]
- Location: `packages/acp-jobs-store/src/scheduler.ts:167-177`.
- Mechanism: any throw during per-job evaluation/mint is recorded as `reason: 'template_error'` regardless of cause. This is a deliberate, documented per-job isolation design and is correct for resilience, but it conflates real template errors with other failures in the ledger.
- Direction: none recommended; widening `EventJobSkipReason` would be a contract change.
- Risk: Med if changed (alters recorded reasons; `event-jobs.test.ts:352` asserts exactly `template_error`). API-impact: public-surface (enum). Leave as-is.
- Contraindication: tests pin current behavior — load-bearing. Do not touch.

## Deliberately left alone (where-NOT)

- **Dual flat + namespaced `JobsStore` facade** (`open-store.ts:656-753`, wiring `2132-2199`): both forms are consumed by `acp-server` non-test code; collapsing either ([T23] remove middle man) would break callers. Not middle-man duplication — a deliberate two-shape API. Leave.
- **Named constants & `JOB_SLUG_REGEX`, `pickNullable`, `MAX_FIRE_SCAN_MINUTES`**: extraction already done; no magic-number debt remains.
- **`cron.ts` `CronField`/`parseFieldPart` dispatch**: a clean small parser; the `matches` closure-per-field is the right shape (variation is real: `*`, `*/n`, ranges, lists, exact). Leave.
- **`flow-validation.ts` two-pass graph validation** (shape pass then acyclic pass): cohesive and well-factored; `addError`/`isRecord`/`hasPresentString` are the correct extracted abstractions. Leave.
- **Optimistic claim loops as check-then-act [T32]**: they ARE check-then-act, but each is wrapped in `sqlite.transaction(...)` with a conditional `UPDATE ... WHERE <still-claimable>` and a `changes===0` guard — atomicity is already enforced at the SQL/transaction layer. No [T32] defect; the only opportunity is the control-flow dedup in F4.
- **Module-level top-level `await` in `sqlite.ts:91`**: intentional driver selection (Bun vs better-sqlite3). Leave.
- **`runInTransaction` passing the outer `store`** (`open-store.ts:2192-2195`): correct — nested calls reuse the same connection; not a middle-man.

## If applying: outside-in sequence

1. [T40] Make-safe first: the existing ~50 tests already characterize the public surface (jobs CRUD, run lifecycle, claim/lease, event drain, flow validation, cron). Run `bun test` in the package to confirm green baseline before any edit. Add a one-line characterization only if F4 proceeds (assert claim ordering + lease-takeover for both `claimDueJobRuns` and `claimPendingInboxEvents`).
2. Boundary narrowing (compiler-proved, no migration): F1, F2, F3 — delete unused exports; run repo-wide `tsc -b` + `bun test`. (Public-surface, so gate with owner per the deferred list, but mechanically trivial.)
3. Internal DRY: F5 (`coalesce` helper) — smallest blast radius; then F4 (claim-loop helper) behind the F40 characterization tests.
4. Leave F6–F9 untouched (notes / deferred design).

## Safety checklist

- [ ] `bun test` green in `packages/acp-jobs-store` before and after each change.
- [ ] Repo-wide `tsc -b` passes after any `index.ts` export removal (proves no consumer broke).
- [ ] For F4/F5: assert the SQL strings and `.run(...)` argument vectors are unchanged (diff prepared statements); claim loops keep their distinct WHERE predicates.
- [ ] Preserve the exact spread/field set in every `toXRecord` mapper — do not add/drop conditional fields.
- [ ] No `typeof`-literal parameterization introduced (avoid biome `useValidTypeof`).
- [ ] Do not touch F7 (status flattening), F8 (ordinal migration), F9 (`template_error`) — they change observable behavior or are pinned by tests; route to redesign.
