# Refactor analysis: `coordination-substrate`

Package type profile: **data** (SQLite-backed immutable event ledger + two small
state machines). Swaps applied where relevant: T13 push-invariant-to-constraint,
T24 batch-N+1 (already done — see below), plus the general toolkit (T07, T12,
T16, T15, T19). The concurrent swaps (T31/T32) were considered because the wake
"lease" looks concurrency-shaped, but the package is single-process SQLite with
serializable `transaction(...)` wrappers, so atomicity is already provided by the
DB — no shared-mutable-state findings.

Not a leaf: real consumers exist (`packages/acp-server/src/coordination/raw-append.ts`,
`packages/acp-server/src/integration/wake-dispatcher.ts`, `packages/acp-server/src/deps.ts`,
`packages/acp-cli`, `packages/acp-e2e`). Therefore M02 (Expand/Contract) governs any
public-contract change; nothing below is proposed as a behavior change.

## Summary

The package is small, cohesive, and already well-factored. A prior pass clearly
landed: the wake/handoff transition mechanics are consolidated in
`commands/transitions.ts`, the N+1 participant fetch is already batched
(`listParticipantsForEvents`), and the session-ref canonical invariant is funneled
through a single enforcer (`util/session-ref.ts`). Most classic smells one would
expect here are **already repaired** — I verified each by re-reading rather than
proposing redundant "extract more" work.

The remaining findings are modest and concentrated at the **public boundary**:
the export surface is wider than any in-repo consumer uses (T07 narrow), and one
type leaks a `string` where the schema constrains a closed set (T12/T15). There
is also one genuine de-abstraction candidate (T16) where the storage-asset path
search anticipates variation that has not materialized, and one minor T15
(duplicated link-column projection across three call sites).

- Files read: 26 (all `src/**`, both `.sql`, `package.json`, `README.md`,
  `test/fixtures/tmp-store.ts`, plus consumer spot-checks).
- Applicable (Low/Med, internal-only, behavior-preserving): 2
- Deferred (public-surface or High-risk): 2

## Public boundary (assessed first)

Verdict: **needs-care (slightly leaky + over-wide).**

`src/index.ts` re-exports four storage lifecycle helpers
(`createCoordinationDatabase`, `listAppliedMigrations`, `readSchemaSql`,
`runMigrations`), the full session-ref quartet
(`canonicalize/format/is/parseCanonicalSessionRef`), `listEventLinks` +
`CoordinationEventLinkRecord`, and the `LocalDispatchAttempt` type. A repo-wide
grep of all consumers (acp-server, acp-core, acp-cli, acp-e2e) shows **none of
these are imported by anyone**:

```
grep -rn "LocalDispatchAttempt|isCanonicalSessionRef|parseCanonicalSessionRef|\
readSchemaSql|createCoordinationDatabase|listAppliedMigrations|runMigrations|\
listEventLinks|CoordinationEventLinkRecord" packages/acp-*  ->  (no matches)
```

Consumers actually use: `CoordinationStore`, `openCoordinationStore`,
`appendEvent`, `leaseWake`, `consumeWake`, and `ParticipantRef`. So the contract
that is exercised is a small core; the rest is speculative surface area
(`openCoordinationStore` already composes create+migrate internally, making the
three lifecycle primitives redundant for callers).

The leaky part: `LocalDispatchAttempt.state` is typed `string`
(`src/types/local-dispatch-attempt.ts:7`) while the only producer
(`src/commands/append-event.ts:292`) ever writes the literal `'queued'` and there
is no transition command for it. The public type is wider than the behavior.

Because these are public-surface, they are **deferred** (M02: a *contract
narrowing* needs an Expand/Contract deprecation cycle or at minimum sign-off that
no out-of-repo consumer depends on them; package is `private: true`, so in-repo
grep is likely sufficient — confirm).

## Findings by mechanism (outside-in)

### F1 — Over-wide export surface: unused lifecycle + session-ref + link exports
- Location: `src/index.ts:23-30` (storage lifecycle), `:43-48` (session-ref
  quartet), `:16-21` (`listEventLinks` / `CoordinationEventLinkRecord`),
  `:40` (`LocalDispatchAttempt`)
- Technique: **T07 align interface to actual usage** (narrow), governed by
  **M02 Expand/Contract** because it is public.
- Mechanism repaired: the module boundary advertises capability that no consumer
  binds to; the published contract is larger than the verified contract,
  inflating the blast radius of every future internal change.
- Direction: remove (from the public index; symbols stay available internally).
- Preservation rung: signature/behavior unchanged for the *retained* surface;
  removal changes the *type-level* contract, so this is a contract edit, not a
  pure refactor.
- Falsifiable signal: after trimming the index, `bun run build` and the full
  monorepo typecheck stay green (no consumer references the removed names);
  `grep` over `packages/acp-*` still returns zero hits for the removed symbols.
- Risk: Med. API-impact: **public-surface**. Effort: S.
- Tests: existing contract tests import from `../../src/index.js`; check 08
  (`hal-readmodel`) — confirm whether it imports `listEventLinks` from the index
  or a deep path before removing that one.
- Contraindication: if this package is intended as a standalone published library
  (it is `"private": true`, so likely not), the lifecycle/session-ref helpers may
  be a deliberate SPI for external embedders. Do not remove `readSchemaSql` /
  migration helpers if any ops/tooling outside this monorepo reads them.

### F2 — `LocalDispatchAttempt.state: string` leaks an open type over a closed set
- Location: `src/types/local-dispatch-attempt.ts:7`; producer
  `src/commands/append-event.ts:292` (writes literal `'queued'`);
  schema column `local_dispatch_attempts.state TEXT NOT NULL`
  (`src/storage/schema.sql:66`) — note: this is the one state column with **no**
  `CHECK` constraint, unlike handoffs/wakes.
- Technique: **T12 make illegal states unrepresentable** + **T13 push invariant
  to constraint** (data swap).
- Mechanism repaired: dispatch state is conceptually a closed lifecycle but is
  encoded as free `string` at both the type and DB layers, so the compiler and
  DB both permit nonsense values; the invariant lives only in the (single) writer.
- Direction: isolate/constrain (introduce a `LocalDispatchAttemptState` union;
  add a `CHECK` in a *new* migration, never by editing `001_initial.sql`).
- Preservation rung: observable behavior preserved **only if** the union exactly
  equals the set of values ever written. Today that is just `'queued'` — there is
  no consumer or completion command, so widening to a real lifecycle
  (`queued|delivered|failed`) would be a **redesign**, not a refactor. Narrowing
  the type to `'queued'` is behavior-preserving but premature.
- Falsifiable signal: typecheck green; a test that inserts an attempt and reads
  back `state === 'queued'` still passes.
- Risk: Med (type is public; tightening `string` -> union can break a consumer
  that assigns it). API-impact: **public-surface**. Effort: S (type) / M (if a
  CHECK migration is added).
- Contraindication: the whole `local_dispatch_attempts` feature is currently
  write-only with no reader in this repo — this may be a deliberately reserved
  seam for a not-yet-built dispatcher. Constraining it now could fight the
  intended design. Defer to a human who knows the dispatcher roadmap.

### F3 — De-abstract the dual-candidate storage-asset path search
- Location: `src/storage/open-store.ts:33-47` (`resolveStorageAssetPath`
  two-candidate fallback: `currentDirectory/relativePath` vs
  `currentDirectory/../../src/storage/relativePath`).
- Technique: **T16 collapse premature abstraction** (the variation — assets
  resolvable from two different layouts — is the accidental generality; the
  `bun` export maps to `./src/index.ts` and `tsc` build emits to `dist/`, so the
  *intended* runtime layout is known, not discovered by probing).
- Mechanism repaired: a runtime existence-probe across two speculative locations
  stands in for a single deterministic resolution; it silently masks a wrong
  build layout instead of failing loud, and adds a branch that has one true arm
  in each real configuration.
- Direction: remove the probe — resolve relative to `import.meta.url`
  deterministically (src run vs dist run differ by a known relative offset that
  the `exports` map already pins).
- Preservation rung: internal-only; `runMigrations`/`readSchemaSql` behavior
  unchanged for the real layouts. NOTE the migration *loop* and the
  one-element `migrations` registry are NOT a finding — that is the canonical,
  forward-correct shape for an event store; collapsing the loop would
  re-introduce the exact problem the next migration creates. Touch only the path
  resolution.
- Falsifiable signal: fresh store open under `bun` (src) and under built `dist`
  both apply `001_initial` and `readSchemaSql()` returns the file contents;
  `migrations.applied === ['001_initial']`, re-open no-ops.
- Risk: Low. API-impact: internal-only. Effort: S.
- Contraindication: the dual-path probe may exist precisely because both `src`
  and `dist` ship and the resolver must work from either — verify the `dist`
  layout offset before deleting a branch. If both layouts genuinely need
  different offsets and neither is derivable, keep the probe.

### F4 — Duplicated link-column projection (row -> record/links) across 3 sites
- Location:
  `src/storage/records.ts:145-173` (`hydrateCoordinationEvent` links block),
  `src/queries/links.ts:89-100` (record mapping),
  plus the column lists duplicated in the two SELECT statements
  (`src/storage/records.ts:225-249` and `src/queries/timeline.ts:74-100`).
- Technique: **T15 extract missing abstraction** (duplicated intent: the
  `coordination_event_links` row <-> object shape is spelled out independently in
  three places; adding a link column means editing all of them — an N-file change
  smell).
- Mechanism repaired: there is no single "link column set" definition; the column
  list and the null-coalescing projection are copy-pasted, so the schema's link
  shape has no code-level single source of truth.
- Direction: relocate/extract — a shared `LINK_COLUMNS` constant for the SELECT
  fragment and a single parse helper reused by both `hydrateCoordinationEvent`
  and `listEventLinks`.
- Preservation rung: **must preserve the exact field set and the exact
  null-vs-undefined handling.** The two existing projections differ subtly:
  `hydrateCoordinationEvent` omits keys when `null` (builds a sparse object and
  returns `undefined` if empty), while `listEventLinks` always emits keys with
  `?? undefined`. A naive merge would change one surface's output. Any extraction
  must keep these two emission policies distinct (extract the *column list* and
  the *parse* helper, not the assembly policy).
- Falsifiable signal: contract tests 08 (hal-readmodel) and 04
  (projection-rebuildability) stay green; a round-trip event with all link fields
  set, and one with none, produce byte-identical JSON before/after.
- Risk: Low-Med (easy to silently change null/undefined semantics).
  API-impact: internal-only (output shape preserved). Effort: M.
- Contraindication: the divergent emission policies are load-bearing; if
  extraction can't cleanly preserve both, leave it. This is the kind of dedup
  that is easy to get subtly wrong — only worth it if the shared piece is just the
  column-name list + `parseJson` calls.

## Deliberately left alone (where NOT to refactor)

- **`schema.sql` vs `migrations/001_initial.sql` are byte-identical** (verified
  with `diff`) — this is *load-bearing* duplication, not a smell. A migration
  file must be frozen at the state it shipped; `schema.sql` is the live
  "current shape" used by `readSchemaSql()`. Deduping them would break the moment
  a `002_*` migration evolves the schema. Both are correctly listed in
  `package.json:files`.
- **`commands/transitions.ts`** — already the correct consolidation of the
  handoff/wake state machines (T19 conditional->dispatch already done). The six
  thin command wrappers (accept/complete/cancel handoff, lease/consume/cancel
  wake) are *not* middle-men to remove: each encodes a distinct legal
  `from`-set/`to` pair (the actual state-machine edges) and is the public verb.
  Collapsing them into one `transition(kind, ...)` would re-flatten a dispatch
  back into a conditional and leak illegal edges.
- **The one-element `migrations` registry + apply loop** (`open-store.ts:23-25,
  78-93`) — canonical forward-correct event-store shape; not a T16 target.
- **`util/session-ref.ts`** — single-enforcer canonical invariant via
  `assertCanonical`; already T15-clean. Both object and string parse paths funnel
  through it.
- **`listParticipantsForEvents` chunked IN(...)** (`records.ts:113-143`) — the
  N+1 (T24) is already batched, with the 500-chunk bound documented against
  SQLite's 999-variable limit. Correct.
- **`util/ulid.ts`** — named constants already kill the magic numbers; BigInt
  encoding intentional. No primitive-obsession finding.
- **`nextProjectSequence`** (`util/sequence.ts`) — runs inside the `appendEvent`
  serializable transaction, so the read-then-update is *not* a T32
  check-then-act race in single-process SQLite. Do not "fix" with
  `UPSERT`/`RETURNING` unless a behavior change is wanted (that is a redesign).

## If applying: outside-in sequence

1. **T40 first:** the contract tests in `test/contract/*.ts` already characterize
   the public surface via `src/index.js`. Run `bun test` to confirm green before
   touching anything; treat that suite as the gate.
2. **F4 (internal, Low-Med)** — extract `LINK_COLUMNS` + parse helper, preserving
   the two distinct emission policies. Re-run tests 04 + 08.
3. **F3 (internal, Low)** — replace the dual-candidate probe in
   `resolveStorageAssetPath` with deterministic `import.meta.url` resolution,
   *only after* confirming the dist offset. Leave the migration loop. Re-run.
4. **F1 (public, Med) — defer / requires sign-off** — narrow `src/index.ts` to
   the consumed core. Only after confirming no external (out-of-repo) consumer.
5. **F2 (public, Med) — defer to dispatcher roadmap owner** — decide whether
   `local_dispatch_attempts` is being narrowed (`'queued'`) or grown
   (real lifecycle = redesign).

## Safety checklist

- [ ] `bun test` green in `packages/coordination-substrate` before and after each
      step (characterization gate).
- [ ] Monorepo typecheck green (`tsc --noEmit` here + acp-server/acp-cli/acp-e2e)
      after any `index.ts` edit — these are the real F1 falsifiers.
- [ ] For F4: a fully-populated link event and an empty-link event serialize
      byte-identically pre/post (preserve null-vs-undefined per surface).
- [ ] For F3: verify resolution works under both `bun` (src) and built `dist`
      before deleting a candidate path.
- [ ] No edits to `migrations/001_initial.sql` (frozen); any constraint change is
      a new migration file.
- [ ] Do not collapse the six transition command verbs, the migration loop, or
      merge the two SQL assets.
- [ ] F1/F2 not landed without confirmation that no out-of-repo consumer binds
      the removed/narrowed symbols (package is `private: true`).
