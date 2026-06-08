# Refactor Analysis — `packages/acp-interface-store`

Analysis only. No source files were modified. Scope: `src/*.ts` (excluding `*.test.ts`, `dist/`, `node_modules/`).

## Scorecard

| Dimension | Rating | Notes |
|---|---|---|
| SRP | C | `open-store.ts` mixes container wiring + schema DDL + 4 ad-hoc migration passes. `delivery-request-repo.ts` mixes row mapping, JSON (de)serialization, and outcome decoding. |
| OCP | C | `mapDeliveryOutcome` is a hardcoded if-chain keyed on `(outcome_state, outcome_reason)`; adding an outcome variant requires editing the chain in two places (read + serialize). |
| LSP | B | No real inheritance hierarchies; the `Sqlite*` interfaces are honored by both Bun/better-sqlite3 adapters. |
| ISP | A | Interfaces are small and focused (`RepoContext`, `SqliteStatement`). |
| DIP | B | Repos depend on the injected `RepoContext`/`SqliteDatabase` abstraction (good). `open-store` hardcodes `new XxxRepo(...)` and the resolver wiring (acceptable for a composition root). |
| DRY | D | Full 26-column `delivery_requests` SELECT duplicated across 4 methods; full INSERT column list duplicated across `enqueue`/`requeue`; binding-repo has 4 near-identical lookup SELECTs and two near-identical lookup methods. |
| Overall | C | Mechanically correct, well-typed, but heavy SQL/column duplication and a fat schema/migration function dominate the debt. |

Total source lines analyzed: **2215** (10 files).

## Priority Refactorings

### P1 — Extract the shared `delivery_requests` column list / row projection
`delivery-request-repo.ts` repeats the identical 26-column `SELECT ... FROM delivery_requests` block in `listQueuedForGateway` (251-281), `get` (370-398), `listByRun` (407-435), and `listFailed` (460-489). The 26-column INSERT column list + placeholder string is duplicated verbatim between `enqueue` (192-219) and `requeue` (514-541). A single `DELIVERY_REQUEST_COLUMNS` constant (and shared INSERT statement string) removes ~150 lines of copy-paste and eliminates the drift risk where one SELECT silently omits a column.
- Principle: DRY / SRP
- Impact: High (drift bugs across queries are the most likely real defect here)
- Risk: Low — pure string extraction, same SQL emitted
- Effort: Low

### P2 — Replace the outcome if-chain with a table-driven decode/encode (`mapDeliveryOutcome`)
`mapDeliveryOutcome` (79-129) is an OCP smell: four `if (row.outcome_state === ... && row.outcome_reason === ...)` branches, each re-parsing details and re-applying the `source` spread. `serializeOutcomeDetails` (166-183) is the inverse. The `(state, reason) -> shape` mapping should live in one place so adding an outcome variant is a single edit. This is a behavior-affecting refactor (it touches how rows decode into the `DeliveryOutcome` union and the default-fill values like `'UNKNOWN'`/`1`), so it must be done under test.
- Principle: OCP
- Impact: Medium
- Risk: Medium — changes decode/encode wiring and default fallbacks
- Effort: Medium

### P3 — Collapse the four duplicated binding lookup SELECTs and the two lookup methods
`binding-repo.ts` `loadByLookup` (277-326) and `loadActiveByLookup` (328-379) differ only by `AND status = 'active'`; each internally branches on `threadRef === undefined` into two near-identical 12-column SELECTs. That is four copies of the same projection. Parameterize the `status` predicate and the `thread_ref IS NULL`/`= ?` clause to reduce to one query builder.
- Principle: DRY
- Impact: Medium
- Risk: Low-Medium — must preserve `thread_ref IS NULL` vs `= ?` semantics exactly
- Effort: Medium

### P4 — Split `initializeSchema` / migrations out of `open-store.ts`
`initializeSchema` (35-231) is a 196-line function that mixes the base CREATE TABLE DDL with four independent migration passes (linked_failure_id add, actor-columns loop, body_attachments add, outcome-columns loop) plus calls into `migrateStructuredScopeColumns` and `tightenInterfaceBindingsConstraints`. The repeated "check pragma_table_info then ALTER" pattern appears 3 times. Extracting a `addColumnIfMissing(sqlite, table, columnDef)` helper and moving schema/migration into a `schema.ts` module restores SRP for the composition root.
- Principle: SRP / DRY
- Impact: Medium
- Risk: Low for the helper extraction; the table-rebuild migration itself is behavior-sensitive and should not be touched.
- Effort: Medium

## Code Smells

| Location | Smell | Detail | Behavior-preserving fix? |
|---|---|---|---|
| `delivery-request-repo.ts:251-489` | Duplication | 26-column SELECT repeated 4x | Yes (extract const) |
| `delivery-request-repo.ts:192-219` / `514-541` | Duplication | INSERT column list repeated 2x | Yes (extract const) |
| `delivery-request-repo.ts:79-129` | OCP / long method | `(state,reason)` if-chain decode | No |
| `delivery-request-repo.ts:497` | Dead param | `void input.requeuedBy` — accepted then discarded | No (signature/contract) |
| `delivery-request-repo.ts:89,103` | Magic value | fallback `'UNKNOWN'` signal, `1` exit code | Partial (named const, same value: yes) |
| `delivery-request-repo.ts:456` | Magic number | default `limit ?? 50` | Yes (named const) |
| `delivery-request-repo.ts:509` | Magic number | id slice length `12` + replace regex | Yes (named const) |
| `open-store.ts:35-231` | Long method / SRP | 196-line schema+migrations | Partial |
| `open-store.ts:149-227` | Duplication | "pragma check then ALTER" pattern 3x | Yes (extract helper) |
| `open-store.ts:366-424` | Magic number | substr offsets 6/7/9 for scope-ref parsing in SQL | Partial (named const, same value) |
| `open-store.ts:436` | Magic number | `busy_timeout = 5000` | Yes (named const) |
| `binding-repo.ts:277-379` | Duplication | 4 near-identical lookup SELECTs / 2 lookup methods | Partial |
| `binding-repo.ts:1-13` | Style | `buildScopeRef` declared above its `import` block (imports not hoisted to top) | Yes (reorder) |
| `binding-repo.ts:24-50` vs `101-114` | Duplication | `assertBindingScope` and `deriveStructuredFields` both re-parse scopeRef and repeat the "must include project" check | No (error-path semantics) |
| `last-delivery-context-repo.ts:69-72` | Dead code / not-implemented | `recordFailedDelivery` voids both args, does nothing | No |
| `last-delivery-context-repo.ts:29-31,74-76` | Thin alias | `record`/`get` just delegate to `recordAckedDelivery`/`getLastDelivery` | No (public API) |
| `outbound-attachment-repo.ts:81-157` | Duplication | 11-column SELECT repeated 3x | Yes (extract const) |
| `outbound-attachment-repo.ts:48` | Magic number | id slice length `16` | Yes (named const) |

## Quick Wins (low-risk, behavior-preserving)

1. Extract `DELIVERY_REQUEST_COLUMNS` const and reuse across the 4 SELECTs in `delivery-request-repo.ts`.
2. Extract `OUTBOUND_ATTACHMENT_COLUMNS` const and reuse across the 3 SELECTs in `outbound-attachment-repo.ts`.
3. Extract `addColumnIfMissing(sqlite, table, columnDef)` to replace the 3 inline pragma-check-then-ALTER blocks in `open-store.ts`.
4. Replace `limit ?? 50` (`delivery-request-repo.ts:456`) with a `DEFAULT_FAILED_LIMIT = 50` const.
5. Replace `busy_timeout = 5000` (`open-store.ts:436`) with a named const.
6. Hoist `buildScopeRef` below the import block in `binding-repo.ts` (move imports to top of file).
7. Name the id-suffix slice lengths (`12` / `16`) as constants in the two repos that mint ids.

## Tech Debt (defer / needs tests before touching)

- `mapDeliveryOutcome` / `serializeOutcomeDetails` table-driven rewrite (P2) — behavior-sensitive default fills.
- Binding lookup query consolidation (P3) — must preserve `thread_ref IS NULL` vs `= ?` exactly.
- `recordFailedDelivery` no-op stub: decide whether to implement (it has a `FailedDeliveryRecord` type + `delivery_requests_failed_idx` index but writes nothing) or remove. Removing changes the public surface.
- `record`/`get`/`recordAckedDelivery`/`getLastDelivery` aliasing in `LastDeliveryContextRepo`: collapse to one name once callers are checked across the repo.
- `requeue`'s `requeuedBy` parameter is accepted and discarded (`void input.requeuedBy`) — either persist it (provenance) or drop it from the signature.
- The `interface_bindings` table-rebuild migration (`tightenInterfaceBindingsConstraints`) and the SQL `substr`-based scope-ref backfill are data-migration code: do NOT refactor without a migration test corpus.

## Safety Checklist (before applying any change)

- [ ] Run the package test suite (`*.test.ts` exist alongside `src`) before and after.
- [ ] For the duplicated-column extractions, diff the emitted SQL string to confirm byte-identical query text.
- [ ] Do not alter the migration/backfill SQL or the table-rebuild path.
- [ ] Treat any change to `mapDeliveryOutcome`, the lookup queries, `recordFailedDelivery`, the `record`/`get` aliases, and the `requeuedBy` param as behavior-affecting — gate on tests + reviewer.
- [ ] Verify `PRAGMA foreign_keys`/`journal_mode`/`busy_timeout` ordering in `createSqliteDatabase` is unchanged.
