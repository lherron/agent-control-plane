# Refactor Analysis: `acp-admin-store`

Package: `packages/acp-admin-store`
Profile: **data** (SQLite-backed record store). Concurrency is delegated entirely to SQLite (`busy_timeout`, WAL, `runInTransaction`); there is no shared mutable JS state, so the concurrent-profile swaps do not apply. Perf swaps are largely N/A (queries are indexed and point/range based).

## Summary

The package is a thin, well-tested (~84 tests across 10 spec files) SQLite scaffold exposing six record stores (agents, projects, memberships, interface identities, system events, heartbeats) plus migrations, a stale-heartbeat sweep, and a pluggable sqlite driver shim. Code quality is high: row-mappers are consistent, validation is centralized, and the public DTO contract is faithfully reconstructed from columns.

The single highest-leverage finding is at the **boundary**: `index.ts` re-exports **12 per-section store-handle factories** (`createInMemoryAgentsStore`/`openSqliteAgentsStore`, ... one pair per section) that **no external consumer imports** — they exist solely to give the package's own per-section unit tests a narrow handle. This is a fat export surface and a premature abstraction (`StoreHandle<T>` + `createStoreHandle`) whose only instantiator is the test suite. Everything else is small, internal, behavior-preserving cleanup.

One pre-existing functional oddity worth flagging (not auto-applicable): `MembershipsStore.add` re-runs the same SELECT three times via a nested ternary/IIFE; and `checkStaleHeartbeats` does an O(projects x memberships) scan to resolve a project per stale agent (latent N+1). Both are flagged with their risk.

## Public boundary — assessed FIRST. Verdict: **needs-care (leaky/fat)**

`src/index.ts` is the sole entry (`exports["."]`). Surface inventory and actual external usage:

| Export | External consumers (outside the package) |
|---|---|
| `createInMemoryAdminStore`, `openSqliteAdminStore` | **Yes** — acp-server, acp-cli (the real boundary) |
| `OpenSqliteAdminStoreOptions`, `AdminStore`, `UpsertHeartbeatInput` types | **Yes** |
| `checkStaleHeartbeats`, `STALE_HEARTBEAT_THRESHOLD_MS`, `STALE_HEARTBEAT_EVENT_KIND`, `StaleHeartbeatCheckResult` | **Yes** |
| `adminStoreMigrations`, `runAdminStoreMigrations`, `listAppliedAdminStoreMigrations`, `AdminStoreMigration` | **Yes** |
| `SqliteDatabase` (default) + `AdminSqlite*` type aliases | **Yes** |
| `AgentsStore`/`ProjectsStore`/`MembershipsStore`/`InterfaceIdentitiesStore`/`SystemEventsStore`/`HeartbeatsStore` types | Used via `AdminStore.*` (the section types are reachable structurally) |
| **`createInMemoryAgentsStore`, `openSqliteAgentsStore`, `createInMemoryProjectsStore`, `openSqliteProjectsStore`, `createInMemoryMembershipsStore`, `openSqliteMembershipsStore`, `createInMemoryInterfaceIdentitiesStore`, `openSqliteInterfaceIdentitiesStore`, `createInMemorySystemEventsStore`, `openSqliteSystemEventsStore`, `createInMemoryHeartbeatsStore`, `openSqliteHeartbeatsStore`** | **NO external consumer.** Used only by `src/__tests__/*.test.ts` inside this package. |

Verified by repo-wide grep: every per-section factory resolves only to files under `packages/acp-admin-store/`. The boundary leaks 12 functions and the `StoreHandle<T>` type-shape purely to serve internal tests. The genuine boundary (`AdminStore` + a couple of free functions + the sqlite shim) is sound.

## Findings by mechanism (outside-in)

### B1 — [T07] Align interface to actual usage: narrow the 12 unused per-section factory exports
- **Location:** `src/index.ts:2-17` (export list); definitions `src/open-store.ts:1419-1489`; helper `createStoreHandle` `src/open-store.ts:1340-1351`; type `StoreHandle<TStore>` `src/open-store.ts:371-378`.
- **Technique:** T07 (align interface to actual usage) — narrow a fat export.
- **Mechanism repaired:** The public surface advertises 12 section-scoped constructors that exist only because the unit tests wanted a focused handle. The export width does not match real consumer demand; the `StoreHandle<T>`/`createStoreHandle` machinery is structure that exists to support those exports.
- **Direction:** remove (from the public boundary).
- **Preservation rung:** This is a **public-contract change** — apply via **M02 Expand/Contract**, NOT a hard delete. The package is `private: true` and the only out-of-repo concern is none, but it is published to in-repo consumers via the workspace alias. Safe path: (1) keep the factories defined and exported; (2) move them behind a `./testing` subpath export or stop re-exporting from the root once the package's own tests import them from `./open-store.js` directly; (3) the package's own tests are the sole migration target, so the migrate+remove step is fully in-package. Because there are NO external consumers, the contract step is trivial, but it is still public-surface and must be done deliberately.
- **Falsifiable signal:** After narrowing, `grep -r "createInMemoryAgentsStore\|openSqlite.*Store" packages apps` outside `acp-admin-store/` stays empty (already true today), and the package test suite still imports/uses the handles from their relocated location.
- **Risk:** Med. **API-impact:** public-surface. **Effort:** S-M.
- **Tests:** package suite (`*-store.test.ts`) must compile against the relocated import; no behavior assertions change.
- **Contraindication:** If any downstream/published artifact (the `dist` types) is consumed by an external repo not visible here, treat as a real Expand/Contract deprecation window. Within this repo it is internal-only in practice but is structurally public.

### B2 — [T16] Collapse premature abstraction: `StoreHandle<T>` / `createStoreHandle`
- **Location:** `src/open-store.ts:371-378` (`StoreHandle<TStore>`), `src/open-store.ts:1340-1351` (`createStoreHandle`).
- **Technique:** T16 (de-abstract; single-purpose generic with one consumer-set).
- **Mechanism repaired:** A generic wrapper that splices `sqlite`/`migrations`/`runInTransaction`/`close` onto each section. Its only instantiations are the 12 factories from B1, which are themselves test-only. If B1 narrows those, this generic and helper collapse with them.
- **Direction:** remove (coupled to B1).
- **Preservation rung:** Behavior-preserving once B1's relocation lands; this is the mechanical consequence of B1, so it inherits B1's public-surface status (the `StoreHandle` shape is exported indirectly via the factory return types).
- **Falsifiable signal:** `StoreHandle`/`createStoreHandle` have zero references after B1; removing them keeps `tsc --noEmit` green.
- **Risk:** Med. **API-impact:** public-surface (return-type shape). **Effort:** S. **Contraindication:** do not remove before B1's consumers (the tests) are moved off the root re-export.

### C1 — [T23] Remove middle man: collapse the triple-SELECT in `MembershipsStore.add`
- **Location:** `src/open-store.ts:998-1029`.
- **Technique:** T23 (collapse pass-through / dead re-fetch) + T22 (flatten the nested ternary/IIFE).
- **Mechanism repaired:** After the INSERT, the code SELECTs the row to test existence, then SELECTs it **again** inside the ternary to map it, with an IIFE-throw on the `false` arm that can never fire (the row was just inserted). Three round-trips where one suffices, expressed as a control-flow expression that obscures intent. Other stores (`create`, `setDefaultAgent`, `append`) use the simple `const row = ...get(); if (row === undefined) throw; return map(row)` shape — this is the odd one out (low cohesion with its siblings).
- **Direction:** remove duplication / relocate to the sibling pattern.
- **Preservation rung:** Behavior-preserving. The post-insert SELECT cannot be `undefined`; collapsing to a single fetch + `if undefined throw` returns the identical `AdminMembership`. Field set is unchanged (`toAdminMembership` is the mapper either way).
- **Falsifiable signal:** `memberships-store.test.ts` (8 tests, includes idempotent re-add and conflict) stays green; the function issues 2 statements (existence pre-check + insert) instead of 4.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S. **Contraindication:** none — the throwing arm is genuinely unreachable; this is a [T17] partial→total cleanup of a "can't happen" branch as well.

### C2 — [T15] Extract missing abstraction: shared filtered-list query builder (interfaceIdentities.list / systemEvents.list)
- **Location:** `src/open-store.ts:1120-1144` (identities list) and `src/open-store.ts:1198-1230` (system events list).
- **Technique:** T15 (extract duplicated intent — the `clauses[]/values[] -> WHERE ${join(' AND ')}` pattern appears twice).
- **Mechanism repaired:** Both build a dynamic WHERE from optional filters with identical structure. A tiny `buildWhere(pairs)` helper removes the duplicated assembly.
- **Direction:** add (small helper) / relocate shared intent.
- **Preservation rung:** Behavior-preserving — the produced SQL string and bound-param order must be byte-identical. The two call sites differ in operators (`=` vs `>`/`<`), so the helper must take `(column, op, value)` triples, not just equality pairs.
- **Falsifiable signal:** `interface-identities-store.test.ts` and `system-events-store.test.ts` (5 + 7 tests, exercise filter combinations) stay green; the WHERE-assembly code exists once.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** S.
- **Contraindication:** **Marginal — consider leaving alone.** Only two call sites, and over-generalizing a SQL builder risks param-order bugs that the static inline form makes obvious. If applied, keep it dead-simple; do NOT grow it into a general query DSL.

### C3 — [T15] Magic-number/constant ordering & grouping (cosmetic)
- **Location:** `src/open-store.ts:437-441` — `PROFILE_ARRAY_LIMIT`, `PROFILE_ARRAY_ITEM_LIMIT`, `SQLITE_BUSY_TIMEOUT_MS`, `IDENTITY_ID_HEX_LENGTH` are declared *after* `createSqliteDatabase` (line 398) already references `SQLITE_BUSY_TIMEOUT_MS` (line 406). It works due to hoisting of `const` in module scope at call time, but the constant is used above its declaration.
- **Technique:** T15 (already extracted — this is a relocation, T03, for cohesion/readability).
- **Mechanism repaired:** Constants used by `createSqliteDatabase` should sit above first use; grouping all magic numbers at the top of the module improves locality.
- **Direction:** relocate.
- **Preservation rung:** Behavior-preserving (pure reordering of module-level `const`; no temporal-dead-zone issue because the reference is inside a function body called later).
- **Falsifiable signal:** `tsc --noEmit` green; no value changes.
- **Risk:** Low. **API-impact:** internal-only. **Effort:** XS. **Contraindication:** none, but low value — bundle with another pass.

### D1 — [T18] Restructure swallowed error handling in `profile*FromStorage` readers
- **Location:** `src/open-store.ts:535-572` (`profileScalarFromStorage`, `profileArrayFromStorage`) — both `catch {}` and silently return `undefined` when stored profile data fails re-validation.
- **Technique:** T18 (swallowed catch).
- **Mechanism repaired:** On read, invalid stored values are silently dropped rather than surfaced. This is a deliberate read-tolerance choice (data may predate a validation tightening), so the swallow is partly load-bearing — but it is currently invisible. Minimal improvement: keep tolerance but make it observable (a comment is already present at the array path; the scalar path has none).
- **Direction:** isolate (document/justify the tolerance; optionally narrow the `catch` to the validator-thrown `Error`).
- **Preservation rung:** Behavior-preserving if limited to documenting/narrowing the catch; changing the swallow to throw would be a **behavior change (redesign)** and is explicitly out of scope.
- **Falsifiable signal:** `agent-profile.test.ts` stays green.
- **Risk:** Low (doc-only) / High (if changed to throw). **API-impact:** internal-only (doc) / public-surface (if throw). **Effort:** XS.
- **Contraindication:** Do NOT convert to throwing — read-path tolerance of legacy rows is the intended invariant. Leave the swallow; only annotate.

### E1 — [latent N+1] `checkStaleHeartbeats` project resolution scan
- **Location:** `src/heartbeat-stale.ts:47-58`.
- **Technique:** [T24] batch N+1 (data-profile swap).
- **Mechanism repaired:** For each stale agent without a caller-supplied `projectId`, it `store.projects.list()` then `store.memberships.listByProject(p)` for every project until a match — i.e. O(staleAgents x projects x memberships). A single indexed lookup (`SELECT project_id FROM memberships WHERE agent_id = ? ORDER BY created_at LIMIT 1`) replaces the scan; there is no `memberships.listByAgent` on the store interface today.
- **Direction:** add a focused query (and possibly a `MembershipsStore.firstProjectForAgent`/`listByAgent` method).
- **Preservation rung:** **Behavior-sensitive.** The current scan resolves projects in `projects.list()` order (created_at asc), and picks the first project whose membership list contains the agent. A direct query MUST reproduce the same tie-break (project creation order, not membership creation order) to be behavior-preserving — otherwise the emitted `projectId` for multi-project agents could differ. Because matching the exact selection is subtle and it touches a public store method + the event payload, treat as redesign-adjacent.
- **Falsifiable signal:** `heartbeats-store.test.ts` + any stale-check test stay green AND a multi-project-membership case yields the same `projectId`. Without a test pinning the multi-project tie-break, do not change.
- **Risk:** High (selection-order semantics) / public-surface (adds a store method + affects event payload). **API-impact:** public-surface. **Effort:** M.
- **Contraindication:** Stale sweeps are low-frequency batch jobs over small agent counts; the N+1 is not a live hot path. Optimize only if a multi-project tie-break characterization test is added first.

## Deliberately left alone (where-NOT)

- **`AdminProject` dual `homeDir`/`rootDir` mapping** (`src/open-store.ts:642-643`, both from `root_dir`). Looks like duplication but is **load-bearing**: `acp-core`'s `AdminProject` declares both fields (`packages/acp-core/src/admin.ts:34-35`) and acp-server reads both (`launch-role-scoped.ts:230` does `project?.homeDir ?? project?.rootDir`). The spread must preserve the exact field set. Do NOT collapse.
- **`sqlite.ts` Bun-vs-better-sqlite3 driver shim** — a genuine substitution seam ([T01] already correctly applied), flipped at runtime by `typeof Bun`. Not a premature abstraction; both implementors exist. Leave.
- **Per-section store *interfaces*** (`AgentsStore`, etc.) — reachable via `AdminStore` and meaningful as the store's structural contract. Keep the interfaces even if B1 narrows the *factory* exports.
- **`maybeField`/`maybeAgentProfile` optional-field spreads** — these implement the "omit-vs-null" DTO contract precisely (T12-flavored: optional means absent, not `null`). Consistent and correct; do not "simplify" into `?? null` which would change the emitted object shape.
- **`adminStoreMigrations` append-only list** — forward-only migration log; never edit existing entries. Out of scope by definition.
- **Idempotent `create`/`add`/`register` conflict checks** — deliberate "same input returns existing, different input throws" semantics, well covered by tests. Keep.

## If applying: outside-in sequence

1. **[T40] Make-safe gate:** the suite already characterizes each store. Before B1, add (if missing) a one-line assertion that the package tests import the per-section handles from their post-relocation path. Run `bun test` in the package — must be green first.
2. **B1 + B2 together** (Expand/Contract): relocate the 12 factories + `StoreHandle`/`createStoreHandle` off the root re-export (to `./open-store.js` direct import for tests, or a `./testing` subpath), narrow `index.ts`. Re-run package tests + `tsc --noEmit` for `acp-server`/`acp-cli` (must be untouched).
3. **C1** (collapse membership triple-SELECT) — independent, low-risk; run `memberships-store.test.ts`.
4. **C2 / C3** (optional, low value) — only if doing a broader tidy; keep C2 minimal or skip.
5. **D1** — annotate only.
6. **E1** — defer; do not attempt without a multi-project tie-break characterization test.

## Safety checklist

- [ ] `bun test` green in `packages/acp-admin-store` before and after each change.
- [ ] `tsc --noEmit` green in `acp-admin-store`, `acp-server`, `acp-cli`.
- [ ] Repo-wide grep confirms no external consumer of the 12 per-section factories (currently true) before/after B1.
- [ ] B1/B2 routed through Expand/Contract, not a hard delete (public-surface).
- [ ] C1 verified: post-insert row is never undefined; same `AdminMembership` returned.
- [ ] C2 (if applied): generated SQL string + bound-param order byte-identical at both call sites.
- [ ] D1: no swallow converted to throw (read-tolerance preserved).
- [ ] E1: NOT applied unless a multi-project-membership tie-break test pins the selected `projectId`.
- [ ] No change to `adminStoreMigrations` existing entries; field sets in all `to*` mappers unchanged.
