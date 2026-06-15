# Refactor analysis — `packages/acp-conversation`

## Summary

`acp-conversation` is a small, well-factored SQLite scaffold for conversation threads and
turns. Three source files, two test files. The internal mechanics are in good shape: the
render-state machine is already reified (`LEGAL_TRANSITIONS`), the link-field mapping is
already a single source of truth (`LINK_FIELDS`), and `findTurnByLink` already uses static
dispatch over a closed set of queries rather than column interpolation. There is no
duplicated intent, no primitive-obsession to mine, no deep nesting, and no swallowed errors.

The package profile is **leaf + data**. Its only consumer in the repo is `acp-server`
(`src/cli.ts`, `src/deps.ts`, and several tests). Because it is a leaf with a single
in-repo consumer, **M02 Expand/Contract is dropped** — public-contract trims can be done
in place, coordinated with the one consumer, rather than via add-new/support-both/migrate.

The dominant smell is at the **boundary**: `src/index.ts` re-exports 17 names, but the
consumer uses only 5 (`ConversationStore`, `createInMemoryConversationStore`,
`openSqliteConversationStore`, `ConversationThread`, `ConversationAudience`). The entire
`sqlite.ts` surface (default export + four `ConversationSqlite*` type aliases) and the three
module-level migration helpers are dead at the boundary. This is a textbook **[T07] align
interface to actual usage** (narrow a fat export) opportunity.

Verdict on the boundary: **leaky** (over-exported), but everything that ships is otherwise
sound.

## Public boundary (assessed first) — verdict: leaky (over-broad)

`src/index.ts` exports (consumer usage in parentheses, measured against `acp-server/src` and
`acp-server/test`):

Used by consumers (keep):
- `ConversationStore` (20 refs — the load-bearing type)
- `createInMemoryConversationStore` (7 refs — tests)
- `openSqliteConversationStore` (2 refs — `cli.ts`)
- `ConversationThread` (6 refs)
- `ConversationAudience` (2 refs)

Exported but unused by ANY in-repo consumer (dead at boundary):
- `SqliteDatabase` default export (`index.ts:15`) — re-exported from `sqlite.js`
- `ConversationSqliteDatabase`, `ConversationSqliteDatabaseConstructor`,
  `ConversationSqliteRunResult`, `ConversationSqliteStatement` (`index.ts:16-21`) — the
  whole `sqlite.ts` type surface is internal-only in practice
- `conversationStoreMigrations`, `runConversationStoreMigrations`,
  `listAppliedConversationStoreMigrations` (`index.ts:2,4,5`) — migrations run internally
  inside `openSqliteConversationStore`; no consumer calls these
- `ConversationStoreMigration`, `OpenSqliteConversationStoreOptions`,
  `ConversationTurnLinks`, `StoredConversationTurn` — referenced only inside the package
  and the consumers' own re-declared local type shims (the tests redeclare these shapes
  locally rather than importing them — see F3)

The interface `ConversationStore` itself is mostly aligned to usage. One member,
`runInTransaction`, is **not** used by any `ConversationStore` consumer (the
`runInTransaction` calls in `acp-server` are on `interfaceStore`/`wrkqStore`, different
stores). It is plausibly there for store-shape uniformity, so it is care-flagged rather
than proposed for removal (F4).

## Findings by mechanism (outside-in)

### F1 — Narrow the fat boundary export [T07] (boundary, highest leverage)

- **Location**: `src/index.ts:1-21` (and transitively the `export default` in `sqlite.ts:93`).
- **Technique**: [T07] align interface to actual usage — narrow a fat export.
- **Mechanism repaired**: the package boundary advertises its private storage adapter
  (`SqliteDatabase` and the four `ConversationSqlite*` aliases) and its migration plumbing
  as public API. That widens the supported surface far beyond what any consumer needs,
  pinning internal implementation choices (better-sqlite3 / `bun:sqlite` shim, migration
  format) into the contract.
- **Direction**: remove (stop re-exporting `SqliteDatabase` default + `ConversationSqlite*`
  aliases; stop re-exporting the three migration helpers and `ConversationStoreMigration`).
- **Preservation rung**: leaf package, M02 dropped — but this is still a public-surface
  change. Behavior is fully preserved; only the export list shrinks. The drop must be made
  together with a `grep` proof that nothing imports the removed names.
- **Falsifiable signal**: `grep -rn "ConversationSqlite\|runConversationStoreMigrations\|listAppliedConversationStoreMigrations\|conversationStoreMigrations\|default as SqliteDatabase" packages --include=*.ts | grep -v packages/acp-conversation/ | grep -v /dist/`
  returns zero rows today; after the trim, the package typechecks and `acp-server` builds.
- **Risk**: Med. **API-impact**: public-surface. **Effort**: S.
- **Tests**: existing smoke + contract tests cover the kept surface; add nothing.
- **Contraindication**: the migration helpers (`runConversationStoreMigrations`,
  `listAppliedConversationStoreMigrations`) may be a deliberate option seam for an
  out-of-repo consumer or a future migration CLI. Because the package is `private: true`
  and grep is clean, the seam has not materialized — but confirm with the owner before
  removing, since this is a true public-contract trim, not a behavior-preserving internal
  edit. **This is why it is deferred, not auto-applied.**

### F2 — `migrations.applied` snapshot field unused by consumers [T07] (boundary)

- **Location**: `src/open-store.ts:108-110, 358-362` (`ConversationStore.migrations.applied`).
- **Technique**: [T07] align interface to actual usage.
- **Mechanism repaired**: the store eagerly computes and exposes a `migrations.applied`
  snapshot on every open. Only the in-package smoke test reads it
  (`test/smoke.test.ts:7`); no production consumer does. It is a frozen-at-open snapshot,
  so it is also subtly misleading (it never reflects migrations applied later in the same
  process).
- **Direction**: relocate/remove — drop from the public interface; keep
  `listAppliedConversationStoreMigrations` available internally if a debug read is wanted.
- **Preservation rung**: public-surface; the smoke test must change. Behavior of the store
  proper is unchanged.
- **Falsifiable signal**: after removal, the only compile break is `test/smoke.test.ts:7`;
  no `acp-server` reference breaks.
- **Risk**: Med. **API-impact**: public-surface. **Effort**: S.
- **Contraindication**: if any operational tooling introspects `store.migrations.applied`
  out of repo, removing it breaks them. Defer to owner. **Deferred — public-surface.**

### F3 — Tests re-declare DTO shapes instead of importing them [T15/T07] (cohesion)

- **Location**: `src/__tests__/threads-store.test.ts:7-34`,
  `src/__tests__/turns-store.test.ts:7-46`.
- **Technique**: [T15] extract missing abstraction / [T07] use the exported types.
- **Mechanism repaired**: `ConversationAudience`, `ConversationThread`,
  `ConversationTurnLinks`, `StoredConversationTurn`, and the `*StoreApi` shapes are hand-
  copied into the test files instead of imported from `../index.js`. This is duplicated
  intent: the canonical types already exist and are exported. The copies will silently
  drift from the real contract (a field added to `ConversationThread` would not be caught
  by these tests).
- **Direction**: remove the local type shims; import the real exported types.
- **Preservation rung**: test-only, behavior-preserving. No production code touched.
- **Falsifiable signal**: deleting the local `type ConversationThread = {...}` etc. and
  importing them from `../index.js` keeps `bun test` green; a deliberate field rename in
  `open-store.ts` now fails these tests (it currently would not).
- **Risk**: Low. **API-impact**: internal-only. **Effort**: S.
- **Contraindication**: the `requireThreadStoreApi`/`requireTurnStoreApi` helpers exist to
  assert the methods are present at runtime (a structural contract check). Keep those
  runtime assertions; only the *type* shims are the duplication. Do not delete the
  `expect(api.x).toEqual(expect.any(Function))` guards.

### F4 — Care-flag: `runInTransaction` unused by `ConversationStore` consumers [T16] (structure)

- **Location**: `src/open-store.ts:111, 363-366` (`ConversationStore.runInTransaction`).
- **Technique**: [T16] collapse premature abstraction (candidate, not confirmed).
- **Mechanism repaired**: would remove a never-exercised member if it is truly dead. No
  consumer calls `conversationStore.runInTransaction`; the in-repo `runInTransaction` calls
  are all on `interfaceStore`/`wrkqStore`.
- **Direction**: none recommended now — investigate first.
- **Preservation rung**: public-surface; would change the interface.
- **Falsifiable signal**: confirm no caller after a repo-wide grep that disambiguates
  receiver type; if confirmed dead, removal keeps everything green.
- **Risk**: Med. **API-impact**: public-surface. **Effort**: S.
- **Contraindication**: strong — this method is almost certainly present for **store-shape
  uniformity** with the other stores in the family (`interfaceStore`, `wrkqStore` both
  expose `runInTransaction`). Removing it would make `ConversationStore` an asymmetric
  outlier. This is load-bearing consistency, not premature abstraction. **Recommend leave
  alone unless the family is being deliberately re-aligned. Deferred — public-surface.**

## Deliberately left alone (where NOT to refactor)

- **`LEGAL_TRANSITIONS` + `assertLegalTransition` (`open-store.ts:322-337`)** — the render
  state machine is already reified ([T10] done). Do not inline it back into conditionals.
- **`LINK_FIELDS` (`open-store.ts:254-272`)** — already the single source of truth for the
  read (`turnRowToTurn`) and merge (`attachLinks`) arms ([T15] done). The comment correctly
  explains why the `createTurn` INSERT is left positional (bind order pinned to VALUES
  placeholders). Do NOT data-drive the INSERT too — that un-pins the bind order and is
  explicitly load-bearing.
- **`findTurnByLink` static dispatch (`open-store.ts:539-548`)** — the two-arm `if` over a
  closed query set is a deliberate guard against column-name interpolation (SQL-injection
  safety). Do not "simplify" it into `WHERE ${field} = ?`. ([T19] correctly applied.)
- **`sqlite.ts` runtime constructor selection (`sqlite.ts:26-91`)** — the module-level
  `await loadSqliteDatabaseConstructor()` picks `bun:sqlite` vs `better-sqlite3` at load.
  This is a real substitution seam (two live implementations), not premature abstraction.
  The top-level `await` is intentional. Leave the `SqliteDatabase` abstraction in place;
  only its *re-export* from `index.ts` is questionable (F1).
- **Spread-conditional row mappers (`threadRowToThread`, `turnRowToTurn`)** — the
  `...(cond ? {field} : {})` pattern preserves `exactOptionalPropertyTypes` semantics
  (omit vs `undefined`). Do not collapse to plain assignment; the exact field set and its
  optionality is the contract.
- **`projectId` LIKE-pattern matching (`open-store.ts:429-440`)** — the two-pattern
  (`%:project:<id>:%` and `%:project:<id>`) match is covered by a dedicated test
  (`threads-store.test.ts:122-174`) and the comment documents base-vs-deep intent. As-is.

## If applying — outside-in sequence

1. **F3 first** (Low / internal-only / test-only): switch the test type shims to import
   the real exported types and run `bun test`. This lands a safe win and *tightens the
   characterization net* before any boundary trim — making F1/F2 safer to evaluate.
2. **Confirm-then-decide F1** (Med / public-surface): re-run the dead-export grep, get owner
   sign-off (private package, but still a contract trim), then remove the
   `sqlite.ts`/migration re-exports from `index.ts`. Build `acp-conversation` + `acp-server`.
3. **F2** (Med / public-surface): only with owner sign-off — drop `migrations.applied` from
   the interface and update `smoke.test.ts`.
4. **F4**: investigate only; do not remove without a deliberate store-family re-alignment.

## Safety checklist

- [ ] `bun test` green in `packages/acp-conversation` (smoke + thread + turn contracts).
- [ ] `tsc --noEmit` (`typecheck`) clean in `acp-conversation`.
- [ ] `acp-server` typechecks and builds against the trimmed exports.
- [ ] Dead-export grep re-run immediately before any F1/F2 removal (clean = safe to remove).
- [ ] No change to `LEGAL_TRANSITIONS`, `LINK_FIELDS`, `findTurnByLink` dispatch, or the
      spread-conditional row mappers (behavior + injection-safety + optionality contract).
- [ ] Owner sign-off recorded for F1/F2 (public-contract trims on a shared store family).
