# Refactor Analysis — `packages/acp-interface-store`

Package-type profile: **data** (SQLite schema + repository layer). Concurrency swaps
considered (it leases queued rows under a transaction) but the check-then-act paths
are already wrapped in `sqlite.transaction(...)`, so the high-severity [T32] concern
does not materialize. Treated primarily as data with one boundary cleanup.

## Summary

The package is a focused SQLite store: one `open-store.ts` (schema + migrations +
assembly), five repos, one resolver, a shared `RepoContext`, a dual-runtime sqlite
shim, and a single `types.ts`. Internals are clean and consistent (uniform row-map +
`require*` reload pattern). The notable problems are all at the **public boundary**:

1. **Over-exported surface** — `index.ts` re-exports all six concrete repo/resolver
   classes, but no external consumer imports any of them (as value or type). They are
   only instantiated inside `open-store.ts` and reached via the `InterfaceStore`
   interface. (`[T07]` narrow.)
2. **Leaky boundary** — `enqueueIdempotent` is called by acp-server, but its
   parameter type `EnqueueDeliveryRequestIdempotencyInput` and result type
   `EnqueueDeliveryRequestIdempotencyResult` are **not exported**; same for
   `DeliveryOutcome`, which is reachable through public `DeliveryRequest.outcome`.
   (`[T07]` widen.)
3. **Inert public option** — `OpenInterfaceStoreOptions.actor` is accepted (and passed
   by `cli.ts`) but never read by `openInterfaceStore`. Dead contract.
4. **Cross-package type duplication** — `DeliveryOutcome` / `DeliveryRequestStatus`
   are copied from `acp-core`; the copies have drifted (`no_assistant_content.source`
   literal union present in core, absent here).
5. **Dead / placeholder methods** — `LastDeliveryContextRepo.record` and `.get` are
   unused aliases; `recordFailedDelivery` is a no-op kept only for a "future store"
   test cast.

Verdict on the boundary: **needs-care**. It is simultaneously too wide (classes) and
too narrow (idempotency/outcome types), plus carries one inert option.

## Public boundary (assessed first) — verdict: needs-care

`index.ts` exports:
- `openInterfaceStore`, `InterfaceStore`, `OpenInterfaceStoreOptions` — the real
  surface; every external consumer (`acp-server`, `acp-e2e`) uses these.
- `BindingRepo`, `DeliveryRequestRepo`, `LastDeliveryContextRepo`,
  `MessageSourceRepo`, `OutboundAttachmentRepo`, `DeliveryTargetResolver` — **zero**
  external value- or type-imports. The `DeliveryTargetResolver` symbol seen in
  `acp-server` is a *different*, locally-defined function type in `deps.ts`.
- A block of type-only exports. Confirmed externally referenced:
  `InterfaceStore`, `OutboundAttachment`, `DeliveryRequest`/`InterfaceBinding`
  (aliased as `Stored*` in acp-server).

Not exported but reachable/used through the public surface:
`EnqueueDeliveryRequestIdempotencyInput`, `EnqueueDeliveryRequestIdempotencyResult`
(used by `acp-server/handlers/agent-pulpit-messages.ts`), and `DeliveryOutcome`
(public via `DeliveryRequest.outcome` and `EnqueueDeliveryRequestInput.outcome`).

## Findings by mechanism (outside-in)

### F1 — Narrow the export surface: stop re-exporting concrete repo classes
- Location: `packages/acp-interface-store/src/index.ts:3-8`
- Technique: `[T07]` align interface to actual usage (narrow fat exports);
  pair with `[M02]` Expand/Contract because this is a public-contract removal.
- Mechanism repaired: the module advertises six construction-capable classes that the
  ownership model forbids constructing (they need a private `RepoContext`/deps the
  package never hands out). The boundary claims capabilities it does not support.
- Direction: remove (from public surface).
- Preservation rung: behavior-preserving for all real consumers; **public-contract
  removal** of unused exports. Expand/Contract: keep them exported one release, mark
  `@deprecated`, then drop — or drop directly since grep shows no consumers.
- Falsifiable signal: `grep -rE "from ['\"]acp-interface-store" | grep RepoName`
  across the monorepo returns only intra-package hits (verified: it does).
- Risk: Med. API-impact: public-surface. Effort: S.
- Tests: monorepo typecheck + build of `acp-server`/`acp-e2e`; package tests
  (they import from `../src/index.js` only for `openInterfaceStore`).
- Contraindication: these may be intentionally exported for downstream test authoring;
  the package tests themselves do NOT import the classes (they go through
  `openInterfaceStore`), which weakens that justification. Because it is public-surface
  removal, do not auto-apply.

### F2 — Widen the boundary: export idempotency + outcome types actually used
- Location: `packages/acp-interface-store/src/index.ts:9-30` (omission);
  types at `types.ts:146-159` (`EnqueueDeliveryRequestIdempotency*`) and
  `types.ts:12-31` (`DeliveryOutcome`).
- Technique: `[T07]` widen leaky export; `[M02]` add-new (pure addition).
- Mechanism repaired: a public method (`deliveries.enqueueIdempotent`) takes and
  returns types the consumer cannot name; acp-server must structurally infer them.
  `DeliveryOutcome` is reachable through `DeliveryRequest.outcome` yet unnameable.
- Direction: add (export the three types).
- Preservation rung: purely additive; no existing behavior or signature changes.
- Falsifiable signal: after adding, `import type { EnqueueDeliveryRequestIdempotencyResult } from 'acp-interface-store'`
  type-checks in acp-server; today it does not.
- Risk: Low. API-impact: public-surface (additive). Effort: S.
- Tests: typecheck; add a compile-only import in acp-server.
- Contraindication: for `DeliveryOutcome` specifically, prefer re-exporting acp-core's
  canonical type rather than the local drifted copy (see F3) — do not widen a duplicate.

### F3 — De-duplicate `DeliveryOutcome` / `DeliveryRequestStatus` against acp-core
- Location: `packages/acp-interface-store/src/types.ts:9` (`DeliveryRequestStatus`),
  `types.ts:12-31` (`DeliveryOutcome`); canonical source
  `packages/acp-core/src/interface/delivery-request.ts:4,12-31`.
- Technique: `[T15]` extract/converge duplicated intent to one definition.
- Mechanism repaired: two copies of the same union have already drifted
  (`no_assistant_content.source` is `'launch_exit_synthesized' | ... | string` in core,
  bare `string | undefined` here). Two sources of truth for one wire/storage contract.
- Direction: relocate/converge (re-export from acp-core; acp-core is already a dep).
- Preservation rung: **contract-sensitive.** The mapper in
  `delivery-request-repo.ts:138-188` persists/reads exactly these arms; replacing the
  local type with core's must preserve the exact arm set and optionality. The drift
  means the swap is not a no-op at the type level.
- Falsifiable signal: `git diff` of `DeliveryRequest`/`EnqueueDeliveryRequestInput`
  shows no field added/removed; `delivery-request-repo.test.ts` outcome round-trip
  tests (lines 131/167/214) still pass unchanged.
- Risk: High. API-impact: public-surface. Effort: M.
- Tests: full package + acp-server + gateway-discord (gateway-discord uses acp-core's
  `DeliveryOutcome` against acp-core's `DeliveryRequest`).
- Contraindication: the store may deliberately keep a storage-shaped copy decoupled
  from core's API-shaped type to avoid coupling the persistence schema to API
  evolution. This is a design call, not a mechanical refactor — flag, do not auto-apply.

### F4 — Inert public option `OpenInterfaceStoreOptions.actor`
- Location: `packages/acp-interface-store/src/open-store.ts:14-17` (option),
  `:447-479` (`openInterfaceStore` never reads `options.actor`); real caller passes it
  at `packages/acp-server/src/cli.ts:768-770`.
- Technique: `[T16]` remove premature structure (option whose variation never
  materialized) OR `[T01]`/wire-through if the actor is meant to stamp rows.
- Mechanism repaired: the public type promises actor-identity threading that the
  implementation silently discards; `cli.ts` passes `{ agentId: options.actor }`
  believing it matters. Either dead contract or a missing-behavior bug.
- Direction: remove (drop the option) — OR isolate+wire (carry actor into
  `RepoContext` and stamp `actor_*` columns).
- Preservation rung: **behavior-changing if wired** (rows would gain actor values they
  currently lack) — that is a redesign, not a refactor. Removal is a public-contract
  change. Either way not behavior-preserving-and-internal.
- Falsifiable signal: removal — `grep actor open-store.ts` shows only the option line;
  drop it and `cli.ts`/`helpers.ts` callers must drop `actor:` (compile signal).
  Wiring — actor columns become non-null for new rows (observable change).
- Risk: High. API-impact: public-surface. Effort: S (remove) / M (wire).
- Tests: typecheck of `cli.ts`, `helpers.ts`; if wired, new assertions on `actor_*`.
- Contraindication: do not silently delete if product intends actor stamping; needs a
  human decision. Defer.

### F5 — Dead alias methods + no-op on `LastDeliveryContextRepo`
- Location: `packages/acp-interface-store/src/repos/last-delivery-context-repo.ts:29-31`
  (`record` -> delegates to `recordAckedDelivery`), `:74-76` (`get` -> `getLastDelivery`),
  `:69-72` (`recordFailedDelivery` no-op `void`s its args).
- Technique: `[T23]` remove middle man (collapse the two pass-through aliases);
  `[T17]`/`[T16]` for the no-op (a partial/placeholder override that does nothing).
- Mechanism repaired: two names per operation (the canonical `recordAckedDelivery`/
  `getLastDelivery` are the only ones called in production: `gateway-deliveries-ack.ts:25`,
  `delivery-target-resolver.ts:38`). `recordFailedDelivery` is a typed no-op kept alive
  only by a speculative "future store" cast in
  `test/last-delivery-context-store.test.ts:107`.
- Direction: remove (`record`, `get`) / isolate (decide fate of `recordFailedDelivery`).
- Preservation rung: `record`/`get` removal is internal-only (no external caller;
  verified) and behavior-preserving. `recordFailedDelivery` is referenced only via an
  `as`-cast future-API test, so removing it changes nothing observable but may break
  that test's optional-chained call (`futureStore.lastDeliveryContext?.recordFailedDelivery`
  — optional, tolerant of absence).
- Falsifiable signal: delete `record`/`get`; package + acp-server tests stay green
  (no caller). For `recordFailedDelivery`, the test uses `?.` and a cast, so its
  call short-circuits to `undefined` if removed.
- Risk: Low (aliases) / Med (no-op, because of the future-API test). API-impact:
  internal-only (methods are not on a type any external consumer references by name;
  they are reached via `store.lastDeliveryContext`, but only the canonical names are
  called). Effort: S.
- Contraindication: the aliases may be a deliberate forward-compat surface; given zero
  callers and the canonical methods already in use, the dedup is safe internally.

### F6 — Schema-init duplication: column-existence check repeated
- Location: `packages/acp-interface-store/src/open-store.ts:37-49` (`addColumnIfMissing`)
  vs `:343-356` (inline re-implementation of the same `pragma_table_info` existence
  check inside `migrateStructuredScopeColumns`).
- Technique: `[T15]` extract missing abstraction (the existence check already exists as
  `addColumnIfMissing`; the inline loop duplicates it only to also set a `didAdd` flag).
- Mechanism repaired: one "does column X exist, else ALTER" idiom written twice; the
  second copy exists solely to know whether to backfill.
- Direction: relocate/converge — have `addColumnIfMissing` return a boolean
  (added/not), then `migrateStructuredScopeColumns` reduces to mapping that boolean.
- Preservation rung: behavior-preserving, internal-only; same ALTERs, same backfill
  trigger condition.
- Falsifiable signal: `git diff` shows `addColumnIfMissing` gains a `boolean` return;
  the inline `prepare(pragma_table_info...)` block in `migrateStructuredScopeColumns`
  disappears; all migration tests (fresh-open + reopen idempotency) pass.
- Risk: Low. API-impact: internal-only. Effort: S.
- Contraindication: `addColumnIfMissing` is also used for plain column adds where the
  caller ignores the return — adding a return value is backward-compatible. Safe.

### F7 — Duplicated select-by-lookup SQL in `BindingRepo`
- Location: `packages/acp-interface-store/src/repos/binding-repo.ts:351-402`
  (`loadByLookup`) and `:404-457` (`loadActiveByLookup`) — four near-identical
  `SELECT <13 columns> ... WHERE gateway_id/conversation_ref [+ thread_ref] [+ status]`
  blocks differing only by an optional `AND status='active'` and the thread arm.
- Technique: `[T15]` extract the shared column list + WHERE assembly; the 13-column
  projection is already a magnet for drift (it is hand-repeated in `create`/`list`/
  `getById`/`listPrimaryCandidates` too).
- Mechanism repaired: the binding column projection is written out ~6 times; any schema
  change (the package literally rebuilds this table in
  `tightenInterfaceBindingsConstraints`) forces synchronized edits in many spots.
- Direction: extract a `BINDING_COLUMNS` constant (mirroring the existing
  `DELIVERY_REQUEST_COLUMNS` / `OUTBOUND_ATTACHMENT_COLUMNS` pattern already used in the
  sibling repos) and collapse the thread/status arms into a built WHERE.
- Preservation rung: behavior-preserving; identical SQL text produced. Must preserve
  the exact column order and the `LIMIT 1` and `thread_ref IS NULL` vs `= ?` semantics.
- Falsifiable signal: extracted constant equals the current inline list byte-for-byte
  (modulo whitespace); `binding-repo.test.ts` resolve/fallback cases (lines 38/64) pass.
- Risk: Low. API-impact: internal-only. Effort: M.
- Contraindication: parameterizing the WHERE must not turn the `thread_ref IS NULL`
  branch into a bound `= NULL` (never matches in SQL) — keep the null-arm as distinct
  SQL. This is the one place the "dedup" could introduce a behavior bug if done
  carelessly; the column-constant extraction alone is the lowest-risk slice.

### F8 — `enqueue` and `requeue` repeat the 26-column INSERT binding
- Location: `packages/acp-interface-store/src/repos/delivery-request-repo.ts:247-280`
  (`enqueue`) and `:494-551` (`requeue`) — both bind the same 26-column row with the
  same `'queued', ..., NULL, NULL, NULL` tail and the same
  `outcome?.state==='degraded' ? ...` derivations.
- Technique: `[T15]` extract a private `insertDeliveryRow(row)` helper that takes a
  normalized record and runs the single prepared INSERT.
- Mechanism repaired: the outcome-column derivation logic (state/reason/source/details)
  is duplicated verbatim in two methods; a fourth outcome arm would need editing both.
- Direction: extract.
- Preservation rung: behavior-preserving; the `requeue` path additionally sets
  `linked_failure_id` to the source id and `requeue` generates a fresh id + timestamp —
  the helper must keep those as inputs, not recompute. Preserve exact field set.
- Falsifiable signal: both methods call one helper; `delivery-requeue.test.ts` and
  outcome round-trip tests pass; the inserted SQL string appears once.
- Risk: Low. API-impact: internal-only. Effort: M.
- Contraindication: `enqueue` hardcodes `linked_failure_id = NULL` while `requeue`
  passes the source id — the helper must parameterize that field, not assume NULL.

### F9 — `mapDeliveryOutcome` conditional chain growing one arm per outcome reason
- Location: `packages/acp-interface-store/src/repos/delivery-request-repo.ts:138-188`.
- Technique: `[T19]` conditional -> dispatch (table keyed by `outcome_reason`).
- Mechanism repaired: four sequential `if (outcome_state==='degraded' && reason===X)`
  blocks; each new degraded reason appends another near-identical block that re-reads
  `outcome_source` and parses details the same way.
- Direction: convert to a per-reason builder map.
- Preservation rung: behavior-preserving only if the dispatch reproduces each arm's
  exact defaults (`signal ?? 'UNKNOWN'`, `exitCode ?? 1`, errorMessage typeof-guard)
  and the `'normal'` / fallthrough-`{}` cases.
- Falsifiable signal: outcome round-trip tests (131/167/214) unchanged; the four `if`
  blocks become one lookup.
- Risk: Med. API-impact: internal-only. Effort: M.
- Contraindication: the arms are NOT uniform (signal vs exitCode vs errorMessage shapes
  differ), so a dispatch table still needs per-arm builder functions — this is a
  modest readability win, not pure deduplication. The duplicated *intent* is the
  source-extraction, not the whole arm; do not over-abstract divergent shapes. Lower
  priority than F1/F2.

## Deliberately left alone (where-NOT)

- **`sqlite.ts` dual-runtime loader (`Bun` vs `better-sqlite3`).** Looks like a
  one-implementor abstraction but the variation genuinely materializes (the package is
  consumed under Bun for `bun test` and built for Node via `better-sqlite3`). Load-bearing
  `[T16]` contraindication — keep.
- **`runInTransaction` on `InterfaceStore`.** Thin wrapper over `sqlite.transaction`,
  but it is the package's public transactional seam and rebinds `store` for nested use.
  Not a middle-man to collapse.
- **Per-repo `require*`/`requireById` reload-after-write pattern.** Repeated across
  repos but it is a deliberate, cohesive idiom (return the canonical persisted row);
  hoisting it into `shared.ts` would couple all repos to a generic and obscure the
  table-specific error messages. Leave per-repo.
- **The long inline scope-ref backfill SQL (`backfillStructuredScopeColumns`).** Ugly
  nested `instr/substr`, but it is a one-time historical migration with a documented
  grammar and is guarded by `didAdd`. Rewriting risks the migration; freeze it.
- **`tightenInterfaceBindingsConstraints` table-rebuild migration.** High-stakes,
  idempotent, well-commented, with an operator-escape (stderr + lint hint). Do not
  refactor a live data migration for style.
- **Concurrency / `[T32]`:** `leaseNext`, `ack`, `fail`, `requeue`, `upsertByLookup`,
  `enqueueIdempotent` all perform check-then-act inside `sqlite.transaction(...)`.
  The atomicity invariant already holds; no swap needed.

## If applying: outside-in sequence

1. **F2** (additive widen — export idempotency types) — safest, unblocks consumers.
   *Defer the `DeliveryOutcome` half until F3 is decided.*
2. **F6**, **F8**, **F7 (column-constant slice only)** — internal data-layer dedup,
   each behind the full test suite.
3. **F5 (aliases `record`/`get`)** — internal dead-method removal.
4. **F9** — optional readability dispatch, lowest leverage; do last or skip.
5. **F1, F3, F4, F5 (`recordFailedDelivery`)** — DEFERRED. Public-surface or
   behavior-affecting; require human/owner decision (Expand/Contract for F1; design
   call on core-coupling for F3; product decision for F4).

## Safety checklist

- [ ] `bun test` in `packages/acp-interface-store` green (baseline: 28 pass / 0 fail).
- [ ] Monorepo typecheck (`acp-server`, `acp-e2e`, `gateway-discord`) green —
  these are the real consumers; F1/F2/F3 touch their compile surface.
- [ ] For any column-list/INSERT extraction (F6/F7/F8): diff the generated SQL string
  is byte-equivalent; confirm `thread_ref IS NULL` arm not collapsed to `= NULL`.
- [ ] Outcome round-trip tests (`delivery-request-repo.test.ts` 131/167/214) unchanged
  for F8/F9/F3.
- [ ] Migration idempotency: open a fresh DB and re-open an existing one; no F6 change
  alters which ALTER/backfill fire.
- [ ] No `as`-cast `getFutureStore`/future-API test (`delivery-target-resolver.test.ts`,
  `last-delivery-context-store.test.ts`) starts failing after F1/F5.
- [ ] Watch biome `useValidTypeof` only if any dedup parameterizes a `typeof` literal
  (none proposed here, but F9's errorMessage guard touches `typeof`).
