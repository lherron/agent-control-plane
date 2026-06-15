# Refactor analysis — `packages/wrkq-lib`

Read-only analysis. No source was modified. Every source file under `packages/wrkq-lib/src/` was read in full (13 files), plus `package.json`, `README.md`, and consumer-usage greps across the monorepo.

## Summary

`wrkq-lib` is a **data-access package** (thin repositories over a pre-migrated wrkq SQLite file). Profile: **data**, with a small concurrency surface (WAL + `busy_timeout` + transaction wrappers). Applicable swap set: `[T24]` batch N+1, `[T13]` push invariant to constraint, `[T15]` extract missing abstraction. It is **not** a leaf — four external packages (`acp-server`, `acp-cli`, `acp-e2e`, plus tests) consume it — so `[M02]` Expand/Contract applies to any public-contract change.

The code is well-factored: clean separation of repos (`src/repos/`), pure row-mapping (`src/mapping/`), shared SQL helpers (`src/repos/shared.ts`), and a dual-driver SQLite seam (`src/sqlite.ts`). Characterization coverage already exists (5 test files, ~26 cases) — the `[T40]` make-safe gate is largely satisfied, lowering risk for the internal-only items.

The highest-value finding is a genuine **N+1 / per-iteration repeated work** in `EvidenceRepo.appendEvidence` (`[T24]` + `[T25]`). The next tier is small `[T15]` de-duplication (the `printf('X-%05d', ...)` next-id idiom duplicated across two files) and `[T16]` de-abstraction candidates on never-consumed exports. There is **no** premature-abstraction sprawl, no swallowed errors, no deep nesting, and no shared-mutable concurrency hazard.

## Public boundary — assessed first

`src/index.ts` re-exports: `ActorResolver` + `StoreActorIdentity`; four error classes; `assertWrkqSchemaPresent` + `openWrkqStore` + `OpenWrkqStoreOptions` + `WrkqStore`; and the four repo classes (`TaskRepo`, `EvidenceRepo`, `RoleAssignmentRepo`, `TransitionLogRepo`).

Actual external consumption (grep across monorepo, excluding `dist/` and the package itself):

| Export | External use | Notes |
|---|---|---|
| `openWrkqStore` | 6 files | primary entry point |
| `WrkqStore` (type) | 10 refs | primary handle |
| `WrkqSchemaMissingError` | yes (`acp-server/src/http.ts:6`) | `instanceof` mapping |
| `VersionConflictError` | yes (`http.ts:106`) | `instanceof` mapping |
| `WrkqTaskNotFoundError` | yes (`http.ts:94`) | `instanceof` mapping |
| `WrkqProjectNotFoundError` | yes (`http.ts:94`) | `instanceof` mapping |
| `ActorResolver` (class) | 1 file | seed fixture |
| `TaskRepo` / `EvidenceRepo` / `RoleAssignmentRepo` / `TransitionLogRepo` | **0** external | only reached via `WrkqStore` handle |
| `StoreActorIdentity` (type) | **0** external | |
| `OpenWrkqStoreOptions` (type) | **0** external | |
| `assertWrkqSchemaPresent` | **0** external | called internally by `openWrkqStore` |

**Verdict: sound (minor over-export).** The contract is small, intentional, and the heavily-used parts (`openWrkqStore` → `WrkqStore`, the four error classes for HTTP status mapping) are exactly the right shape. The repo classes, two option/identity types, and `assertWrkqSchemaPresent` are exported but never imported by name externally — a slightly **fat** surface. This is a defensible library convenience (a consumer could construct a repo directly), so narrowing is **optional, Low value**, not a leak. Do not narrow without confirming no out-of-tree consumer; treat as deliberate option seam unless the team wants a minimal surface.

## Findings by mechanism (outside-in)

### F1 — `[T24]`/`[T25]` N+1 + loop-invariant work in `appendEvidence` (highest leverage)

- **Location:** `src/repos/evidence-repo.ts:65-104` (the `for (const item of items)` body).
- **Technique:** `[T24]` batch N+1 + `[T25]` hoist loop-invariant work.
- **Mechanism repaired:** per-row database round-trips and repeated computation inside a loop that produce results identical (or trivially derivable) across iterations. Three issues, all inside the loop:
  1. `this.context.actorResolver.getDefaultActor()` is fetched on **every** iteration (`:66`) though it is invariant — hoist above the loop.
  2. `new Date().toISOString()` is recomputed per item (`:77`); minor, but it is a loop-invariant "batch timestamp" recomputed N times.
  3. The next-evidence-id query `SELECT printf('EV-%05d', COALESCE(MAX(...))+1)` is re-run **per item** (`:81-88`). This is the real N+1: appending K evidence items issues K extra `MAX`-scan queries, and it relies on each prior `insert.run` having committed the new MAX — a sequential-allocation pattern that batches poorly and re-scans `evidence_items` K times.
- **Direction:** relocate/restructure (hoist invariants; allocate the id base once, then increment in-process, e.g. seed `nextSeq` from one `MAX` query and `printf` locally per item).
- **Preservation rung:** preserve the exact ID format (`EV-%05d`, zero-padded width 5) and the exact written field set. The locally-incrementing variant must reproduce the same monotonic sequence the per-query loop currently yields for a single call.
- **Falsifiable signal:** after the change, appending K items issues 1 id-base query instead of K (verifiable by counting `prepare`/`get` calls or with a query log); `evidence-repo.test.ts` still green; appended IDs identical for the single-call case.
- **Risk:** Med. **API-impact:** internal-only (observable IDs/timestamps preserved). **Effort:** S–M.
- **Contraindication:** if a concurrent writer can insert between the base query and the inserts, in-process increment could collide where the per-iteration `MAX` would not. Mitigated because `appendEvidence` runs inside a single `sqlite.transaction` and wrkq IDs are guarded by `id GLOB 'EV-[0-9]*'`; confirm no second connection writes evidence concurrently before applying. If concurrency cannot be ruled out, keep the per-iteration query and apply only items (1) and (2).

### F2 — `[T15]` extract the duplicated "next sequential ID" idiom

- **Location:** `src/actor-resolver.ts:47-55` (`printf('A-%05d', ... substr(id,3) ... GLOB 'A-[0-9]*')`) and `src/repos/evidence-repo.ts:81-88` (`printf('EV-%05d', ... substr(id,4) ... GLOB 'EV-[0-9]*')`).
- **Technique:** `[T15]` extract missing abstraction (duplicated intent + magic offsets).
- **Mechanism repaired:** the same "compute next zero-padded sequential business ID from a prefix" algorithm is written twice with hand-tuned, prefix-coupled magic numbers (`substr(id, 3)` for `A-`, `substr(id, 4)` for `EV-`; the offset must equal `prefix.length + 1`). Two copies = two places to get the offset wrong; the offset is currently an unexplained literal derived from the prefix.
- **Direction:** extract to one helper in `src/repos/shared.ts`, e.g. `nextSequentialId(sqlite, table, prefix)` that derives `substr` offset from `prefix.length + 1` and builds the GLOB from the prefix — removing the magic offset entirely.
- **Preservation rung:** preserve exact emitted IDs (`%05d` width, prefix, GLOB filter semantics). The generated SQL must be character-equivalent in behavior for the existing two call sites.
- **Falsifiable signal:** both call sites delegate to one helper; tests in `actor-resolver`-exercising `task-repo.test.ts`/`role-assignment-repo.test.ts` and `evidence-repo.test.ts` still produce `A-00001`/`EV-00001`-style IDs.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** if F1 is applied (id allocated once + in-process increment), the evidence call site no longer uses the per-query helper, so apply F2 **after** deciding F1 — they touch the same code. The actor-resolver site (single allocation, not in a loop) keeps the query form regardless. Naming churn: one new exported-internal helper.

### F3 — `[T15]` reify the inline waiver-meta parse in transition lookup

- **Location:** `src/repos/transition-log-repo.ts:46-53` (the inline `details !== undefined && typeof details === 'object' && details !== null ? (details as Record<...>)['waiverKind'] : undefined`).
- **Technique:** `[T15]` extract missing abstraction (re-implements record-narrowing that already exists).
- **Mechanism repaired:** `src/json.ts` already exports `isRecord(value)` for exactly this "is it a non-null, non-array object" check, but this site hand-rolls the narrowing inline and then casts. Duplicated intent against an existing utility.
- **Direction:** replace the inline guard with `isRecord(details)` (already imported indirectly via `parseJsonValue` from the same module), reading `details['waiverKind']`.
- **Preservation rung:** identical truthiness — `isRecord` excludes arrays, which the inline check does **not**; verify no waiver `meta` is a top-level JSON array (it is written via `stableStringify` of an object, so arrays can't occur). Preserve the `typeof waiverKind === 'string'` gate.
- **Falsifiable signal:** `transition-log-repo.test.ts` (which exercises waiver citation) stays green; the diff removes the three-part inline guard.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** none material (the array divergence is unreachable given how `meta` is produced); still, re-confirm before applying since it is a subtle behavior detail.

### F4 — `[T07]` narrow over-exported public surface (optional)

- **Location:** `src/index.ts:1-14` — `TaskRepo`/`EvidenceRepo`/`RoleAssignmentRepo`/`TransitionLogRepo` classes, `StoreActorIdentity`, `OpenWrkqStoreOptions`, `assertWrkqSchemaPresent` (all 0 external consumers).
- **Technique:** `[T07]` align interface to actual usage (narrow fat exports).
- **Mechanism repaired:** the export list is wider than the realized usage; the repo classes are only ever reached through the `WrkqStore` handle, and `assertWrkqSchemaPresent` is an internal step of `openWrkqStore`.
- **Direction:** remove (de-export) — but only behind `[M02]` Expand/Contract since this is public surface with potential out-of-tree consumers.
- **Preservation rung:** N/A for behavior; this is a contract change, not a refactor. Must follow add-new→support-both→migrate→remove-old and confirm no consumer outside this monorepo.
- **Falsifiable signal:** monorepo build/typecheck green after de-export; no `import { TaskRepo } from 'wrkq-lib'` anywhere.
- **Risk:** Med (contract removal). **API-impact:** **public-surface**. **Effort:** S.
- **Contraindication:** these are reasonable library conveniences (a consumer may legitimately want to construct a repo directly or call the schema assertion). Treat as a **deliberate option seam** unless the team explicitly wants a minimal surface. Recommend **leave alone** absent that directive.

## Deliberately left alone (where-NOT)

- **`src/sqlite.ts` dual-driver seam** — the `if (typeof Bun !== 'undefined')` Bun-vs-`better-sqlite3` branch and the `SqliteDatabase`/`SqliteStatement` interfaces look like a one-implementor abstraction, but the variation is **real and materialized** (Bun runtime in dev/tests via `bun:sqlite`, `better-sqlite3` for the built `dist`). This is a load-bearing substitution seam (`[T01]`), not premature abstraction (`[T16]`). Keep.
- **Top-level `await loadSqliteDatabaseConstructor()` (`sqlite.ts:91`)** — module-level await is intentional driver selection; collapsing it would break the dual-runtime contract. Leave.
- **Per-method `sqlite.transaction(...)(arg)` wrappers in every repo** — verbose but uniform and correct; they give each public method atomicity. Not a middle-man (`[T23]`); the indirection buys the transaction boundary. Leave.
- **Error classes (all four)** — each carries distinct construction data and is matched by `instanceof` in `acp-server/src/http.ts` for status mapping. Collapsing to one error type would break HTTP error mapping (a redesign, not a refactor). Leave.
- **`normalizePresetColumns` invariant throws (`mapping/task-row.ts:49-75`)** — these are real domain invariants ("phase must be null for non-preset tasks"; "preset+version both-or-neither"). This is `[T17]`/`[T12]` already done correctly in code; do not "soften" to no-ops. Leave.
- **Field-by-field row mappers (`mapping/*.ts`)** — verbose conditional-spread construction, but each preserves the exact optional-field set the `acp-core` DTOs require; any "simplification" risks dropping/adding fields. The spread/projection preservation rung makes these high-risk to touch for low gain. Leave.
- **`json.ts` `stableStringify` recursion** — pure, small, correct (sorted-key canonicalization for stable hashing/equality). No change.

## If applying — outside-in sequence

1. `[T40]` Confirm the gate: run `bun test` in `packages/wrkq-lib` (5 files, ~26 cases) and ensure green before touching anything. The make-safe net already exists; do not start without it.
2. **F1** (`evidence-repo.ts`) — hoist `getDefaultActor()` and the batch timestamp; decide the id-allocation strategy (per-query vs single-base+increment) per the concurrency contraindication. Re-run `evidence-repo.test.ts`.
3. **F2** (`shared.ts` + `actor-resolver.ts`, and `evidence-repo.ts` if F1 kept a query form) — extract `nextSequentialId`. Apply after F1 since both edit the evidence id site.
4. **F3** (`transition-log-repo.ts`) — swap inline guard for `isRecord`. Independent; can land anytime.
5. **F4** — only if the team wants a minimal surface; run the full `[M02]` Expand/Contract across consumers. Otherwise skip.
6. Full monorepo `typecheck` + `bun test` (consumers: `acp-server`, `acp-cli`, `acp-e2e`).

## Safety checklist

- [ ] `bun test` green in `packages/wrkq-lib` before and after each change.
- [ ] Appended evidence IDs unchanged (`EV-%05d`) and monotonic within a single `appendEvidence` call (F1/F2).
- [ ] No new cross-connection concurrency assumption introduced by F1 (id allocation stays inside the existing transaction).
- [ ] Exact written/returned field sets preserved in all mappers (no spread refactor of `mapping/*.ts`).
- [ ] `isRecord` substitution (F3) re-verified to not change waiver-citation behavior (array case unreachable but confirmed).
- [ ] `acp-server`/`acp-cli`/`acp-e2e` typecheck + tests green (error-class `instanceof` mapping and `WrkqStore` handle intact).
- [ ] No biome `useValidTypeof` regression (F3 removes a `typeof === 'object'`; F2 introduces no `typeof` literal).
- [ ] F4 NOT applied unless an explicit minimal-surface directive exists and out-of-tree consumers are ruled out.
