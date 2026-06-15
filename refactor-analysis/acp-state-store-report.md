# Refactor Analysis — `packages/acp-state-store`

Package-type profile: **data** (SQLite schema + repositories). Swaps considered: [T27] normalize, [T13] push invariant to constraint, [T24] batch N+1. Also relevant given lease/claim semantics: a light [T32] atomic check-then-act lens. NOT a leaf — it has live external consumers (`acp-server`, `acp-e2e`), so [M02] Expand/Contract governs any public-contract change.

## Summary

The package is in good shape. It is a thin, disciplined persistence layer: one schema initializer + migration ladder (`open-store.ts`), one shared helper module, and ten focused repos. Mapping code is uniform (`row -> domain` and `domain -> row`), conflict/idempotency semantics are explicit and well-documented, and characterization coverage is strong (~90 test cases across 9 files, including deterministic run-id and lease tests). Several would-be smells are already paid down: the run-patch "apply-iff-present" ladder is extracted and commented (`applyDefinedRunPatch`), SQL projections are hoisted to single-source constants in the larger repos (`RUN_SELECT_SQL`, `TRANSITION_OUTBOX_COLUMNS`, `SELECT_COLUMNS`), and the effect-intent lifecycle is collapsed into one `transitionEffectIntent` dispatcher.

Findings are mostly low-risk, internal-only quality cleanups: dead helpers in `shared.ts`, an inconsistently-applied `toOptional*` helper family, two repos that hand-roll a `selectSql()` method instead of the module-constant pattern the rest of the package uses, and a duplicated `parse*Array`/`parseJsonRecord` intent. There is one behavior-flagged item (`markErrored` sets status to `'leased'`, not a dedicated error state) that is a possible latent redesign, not a refactor — flagged High/public-surface and NOT auto-applied.

## Public boundary — assessed FIRST

Surface (`src/index.ts` + `AcpStateStore`): the store factory `openAcpStateStore`, the `AcpStateStore` aggregate (per-repo accessors + `runInTransaction` + `close` + raw `sqlite`), 10 repo classes, `deriveRunId`, two error classes, and a broad set of input/record types.

Verdict: **sound, with one narrow leak.**

- Cohesive and accurately named; every exported repo is reachable from `AcpStateStore`. Consumer usage confirms the surface is real, not speculative: `RunCorrelationConflictError` (17 refs), `listRunsByStatus` (5), `deriveRunId` (4), `workflowRuntime.*` (4), `InputAttemptConflictError` (2), `listDispatchableSessionHeads` (1) are all exercised by `acp-server`/`acp-e2e`.
- The one leak: `AcpStateStore.sqlite` is exposed and heavily used by consumers (18 refs in `acp-server`). That is a deliberate escape hatch (consumers run their own SQL and even read discrete run columns directly in tests), so it is load-bearing today — do NOT narrow it. Noted as the surface's one impurity, not an action item.
- `WorkflowRuntimeRepo` exposes ~10 public methods but consumers use only `loadSnapshot`/`saveSnapshot`/`listPendingEffectIntents`. The `markEffectIntent*`/`leaseEffectIntent` methods are part of the effect-delivery contract used by `acp-server`'s scheduler path; treated as in-contract, not over-exposed.

## Findings by mechanism (outside-in)

### Boundary

None requiring change. The export set aligns with actual usage; no fat export to narrow and no leaky export to widen beyond the already-deliberate `sqlite` hatch. M02 therefore has nothing to migrate this pass.

### Seams & structure

**F1 — [T16] Remove dead `toOptional*` helpers (de-abstract)**
- Location: `packages/acp-state-store/src/repos/shared.ts:29-39` (`toOptionalNumber`, `toOptionalBooleanFromInt`).
- Mechanism repaired: speculative abstraction whose variation never materialized — two of the three `toOptional*` helpers have zero call sites anywhere in the repo (only `toOptionalString` is used, by `transition-outbox-repo.ts`). Carrying them implies a uniform mapping convention that the codebase does not actually follow.
- Direction: remove.
- Preservation rung: dead-code deletion; no behavior, no public export (these are not re-exported from `index.ts`).
- Falsifiable signal: `grep -rn 'toOptionalNumber\|toOptionalBooleanFromInt' packages` returns only the definitions; build + `bun test` stay green after deletion.
- Risk: Low. API-impact: internal-only. Effort: trivial.
- Tests: existing suite (no test references them).
- Contraindication: none. (If a future repo wants the convention, re-add at point of use.)

**F2 — [T15] Apply (or retire) the `toOptionalString` convention consistently**
- Location: mappers across `run-repo.ts:163-191`, `input-application-repo.ts:38-54`, `input-queue-repo.ts:33-56`, `wrkf-route-idempotency-repo.ts:43-58`, `pbc-continuation-jobs-repo.ts:64-83` vs. the single user `transition-outbox-repo.ts:51-53`.
- Mechanism repaired: duplicated intent expressed two ways — most mappers inline `row.x !== null ? { x: row.x } : {}` for optional fields while one repo routes through `toOptionalString`. The inline spread form is itself a deliberate, load-bearing idiom (it controls `exactOptionalPropertyTypes` object shape), so the right move is the smaller one: keep the inline-spread idiom as the package convention and fold `transition-outbox-repo` onto it, letting F1 remove the now-orphaned helper.
- Direction: relocate/normalize toward one idiom (remove the outlier helper use).
- Preservation rung: spread/projection refactor — the exact emitted field set must be preserved (a field is present iff non-null). `toOptionalString` returns `undefined` and is then spread via `...(x !== undefined ? {x} : {})`, so converting to the direct null check yields identical objects.
- Falsifiable signal: `transition-outbox.test.ts` (acp-server) + this package's smoke test still assert identical record shapes.
- Risk: Low. API-impact: internal-only. Effort: small.
- Contraindication: do NOT go the other direction (mass-converting every inline check to a helper) — that would obscure the optional-property-shape intent and add an abstraction the package does not need. Pick one direction: the inline idiom.

**F3 — [T15] Unify `selectSql()` instance-method projections with the module-constant pattern**
- Location: `input-application-repo.ts:168-183` (`private selectSql()`), `input-queue-repo.ts:226-246` (`private selectSql()`).
- Mechanism repaired: the same "single-source the column list so SELECTs cannot drift" intent is implemented three different ways across the package — module const string (`RUN_SELECT_SQL`, `SELECT_COLUMNS`, `TRANSITION_OUTBOX_COLUMNS`) in three repos, but a per-instance method in these two. The method form rebuilds the string on every call and reads as if it could vary per instance (it cannot). Hoist to a module-level `const` to match the dominant idiom and make the invariant ("one projection per table") visible.
- Direction: relocate (method -> module const), de-abstract (drop the needless method indirection).
- Preservation rung: pure string hoist; query text byte-identical.
- Falsifiable signal: input-queue / input-application tests in acp-server still pass; emitted SQL unchanged (diff the literal).
- Risk: Low. API-impact: internal-only. Effort: small.
- Contraindication: none — these methods take no parameters and close over nothing.

**F4 — [T15] Collapse duplicated JSON-array parse helpers**
- Location: `wrkf-participant-captures-repo.ts:46-52` (`parseStringArray`) and the array parses scattered through `workflow-runtime-repo.ts` (`parse<string[]>(...)` at e.g. lines 584, 589, 788) plus `parseJsonRecord` in `shared.ts:41-54`.
- Mechanism repaired: `shared.ts` already owns the "parse a typed JSON column, validate the shape, else throw" intent for objects (`parseJsonRecord`). `parseStringArray` is the array sibling and lives privately in one repo; a `parseStringArray` in `shared.ts` would let the captures repo and the workflow-runtime array reads share one validated parser instead of a mix of validated-local and unchecked `parse<string[]>`.
- Direction: extract the missing shared abstraction; relocate `parseStringArray` to `shared.ts`.
- Preservation rung: behavior-preserving where the local validated form is reused as-is. Note: `workflow-runtime-repo.ts`'s `parse<string[]>` does NOT currently validate array-ness, so swapping it to the throwing parser would ADD a guard — that is a (small) behavior change for malformed rows and should be scoped as its own step, not bundled.
- Falsifiable signal: captures repo tests pass unchanged after relocation; if/when applied to workflow-runtime, snapshot round-trip tests stay green for well-formed data.
- Risk: Low (relocate-only) / Med (if extended to workflow-runtime's unchecked parses). API-impact: internal-only. Effort: small.
- Contraindication: keep the relocate step (Low) separate from the validation-tightening step (Med); do not silently change error behavior for the snapshot path.

**F5 — [T15] Two `stableStringify`/`stableJson` implementations of the same intent**
- Location: `input-attempt-repo.ts:50-65` (`stableStringify`) and `workflow-runtime-repo.ts:223-242` (`stableJson` + `sortJson`).
- Mechanism repaired: duplicated intent — both produce a deterministic, key-sorted JSON serialization for fingerprint/hash stability, with slightly different rules (`workflow-runtime` drops `undefined` keys and recurses via `sortJson`; `input-attempt` sorts via `localeCompare` and keeps a flat structure). Two canonicalizers in one package is a correctness hazard if they ever need to agree.
- Direction: extract one canonical-JSON helper into `shared.ts` (or `acp-core` if cross-package canonicalization is wanted).
- Preservation rung: fingerprint/hash STABILITY is a hard invariant — `input_attempts.fingerprint` and `workflow_events.event_hash`/`command_hash` are persisted and compared on replay. Unifying the two MUST reproduce each existing serialization byte-for-byte, or it silently invalidates stored fingerprints/hashes. Because the two rule sets differ (undefined-dropping, sort collation), a true merge is not behavior-preserving.
- Falsifiable signal: a golden-fingerprint test (hash a fixed input, assert the exact stored string) before and after.
- Risk: Med (risk of breaking persisted fingerprint/hash compatibility). API-impact: internal-only (but data-compat-sensitive). Effort: medium.
- Contraindication: STRONG — do not merge unless a characterization test pins both existing serializations first. Safer framing: document the divergence rather than unify. Left mostly alone (see below); listed here for the mechanism, deferred for the risk.

### Invariants / illegal states

**F6 — [T17 / behavior flag] `markErrored` parks failed events in `'leased'`, not a failed/retry state**
- Location: `transition-outbox-repo.ts:154-167`.
- Observation: on delivery error the row is set to `status = 'leased'` (keeping `last_error`), even though the schema admits `'failed'`. `leaseNext` re-picks `'leased'` rows, so this is the intentional "retry forever" path — but it means the `'failed'` terminal state is never written by the repo, and an errored item is indistinguishable by status from a freshly-leased one (only `last_error` differs). Whether errored items should ever become terminal `'failed'` is a policy question.
- Mechanism (if changed): reify the implicit retry state machine / make the failed state representable — but that is a **redesign** of delivery semantics, not a behavior-preserving refactor.
- Direction: none auto-applied. Flag only.
- Preservation rung: n/a — any change here changes observable retry/terminal behavior and the reconciler that drains the outbox.
- Falsifiable signal: `transition-outbox-reconciler` + `transition-outbox.test.ts` behavior would shift.
- Risk: High. API-impact: public-surface (delivery contract observed by `acp-server` reconciler). Effort: medium.
- Contraindication: this is the kind of thing the prompt says to flag, not apply. Confirm intent with a human before touching.

### Error handling / quality

**F7 — [T18] `parseJsonRecord` throws a generic `Error` for malformed/array payloads**
- Location: `shared.ts:41-54`, and the analogous `parseStringArray` form in `wrkf-participant-captures-repo.ts:46-52`.
- Mechanism repaired: expected-but-exceptional data corruption is signaled with a bare `Error('Expected JSON object payload')` carrying no column/table/row context, making field-level corruption hard to localize at the call site (`mapRunRow`, `mapTransitionOutboxRow`, etc.).
- Direction: isolate — give the parser an optional context label (column name) so the thrown message identifies the offending field; or a small typed `StateStoreParseError`.
- Preservation rung: error TYPE/throw-or-not is unchanged for well-formed data; only the message/diagnostic improves. Keep it throwing (callers rely on throw-on-corruption).
- Falsifiable signal: existing tests (which only feed well-formed data) stay green; a new negative test asserts the richer message.
- Risk: Low. API-impact: internal-only. Effort: small.
- Contraindication: do not convert to a non-throwing/return-undefined form — silently dropping corrupt metadata would mask data bugs.

### Data-profile swaps (T27 / T13 / T24 / T32)

- **[T24] N+1:** `loadSnapshot` issues ~14 sequential full-table scans, but that is the inherent shape of a "load the whole kernel" snapshot read; there is no per-row follow-up query, so no true N+1 to batch. `writeContextHashes` and `writeHrcRunMaps` loop `stmt.run` over prepared statements (the correct batched idiom). No action.
- **[T13] push invariant to constraint:** status check-constraints already exist in-schema for `runs`, `transition_outbox`, `wrkf_route_idempotency`, `wrkf_participant_captures`, `pbc_continuation_jobs`. Notably `input_admissions.status`, `input_applications.status`, and `input_queue.status` have NO `CHECK` constraint (free `TEXT`), while their TS types are closed unions (`InputQueueStatus`, `InputApplicationStatus`). Adding `CHECK (status IN (...))` would push the union invariant to the DB. Flagged as data-hardening but it is a **schema/behavior change** on a shared DB (existing rows could violate a newly-added constraint, and SQLite cannot add a CHECK without a table rebuild), so NOT auto-applied — see deferred F8.
- **[T32] atomic check-then-act:** lease/claim flows (`acquireLaunchClaim`, `acquireLease`, `admitOrReplay`, `setOrConflict`, `SessionAdmissionSequenceRepo.reserve`) all wrap their read-then-write in `sqlite.transaction(...)`, and the DB uses `busy_timeout=5000` + WAL. For the single-writer/serialized-access model this package targets, the check-then-act windows are inside transactions and the unique constraints backstop them. No concurrency defect to repair under the current model.
- **[T27] normalize:** the run<->dispatch-fence dual representation (`dispatch_fence_json` AND discrete `expected_host_session_id`/`expected_generation`/`follow_latest` columns, written together in `toPersistedRun`) looks like denormalization, but the discrete columns are read directly by an external consumer test (`acp-server` `run-store-sqlite.test.ts:118-136`). Load-bearing — do NOT collapse. No action.

## Deliberately left alone (where-NOT)

- `AcpStateStore.sqlite` raw escape hatch — deliberate, heavily used by consumers; narrowing it would break `acp-server`. (T07 contraindicated.)
- Run<->dispatch-fence dual columns — denormalized on purpose; discrete columns are part of the externally-read schema. (T27 contraindicated.)
- The two canonical-JSON serializers (F5) — unifying risks invalidating persisted fingerprints/hashes; documented, not merged, absent golden tests. (T15 contraindicated without make-safe first.)
- `applyDefinedRunPatch` / `RUN_PATCH_PASSTHROUGH_KEYS` (`run-repo.ts:36-67`) — already the correct extraction with an explicit "present-vs-undefined" comment; the single typed-key cast is justified and documented. Leave.
- `transitionEffectIntent` dispatcher (`workflow-runtime-repo.ts:465-513`) — already the collapsed form of three near-identical mark* methods; the three thin wrappers are an intentional, readable public API. Leave.
- `InputAttemptRepo.hasLegacyActorAgentIdColumn` probe + conditional column assembly (`input-attempt-repo.ts:91-190`) — a deliberate back-compat seam for old DBs, documented with an invariant comment. Do NOT de-abstract; the variation is real (legacy vs. current schema).
- The migration ladder in `open-store.ts` (add-column-if-missing + table-rebuild functions) — verbose but each function is a discrete, idempotent migration step; this is the correct shape for an additive migration history. Leave.

## If applying: outside-in sequence

1. [T40] Make-safe: confirm the existing suite is green (`cd packages/acp-state-store && bun test`). For F5/F7 negative paths, add golden/negative characterization tests FIRST.
2. F1 — delete dead `toOptional*` helpers.
3. F2 — fold `transition-outbox-repo` onto the inline-spread idiom (do together with F1).
4. F3 — hoist `selectSql()` methods to module consts in `input-application-repo` and `input-queue-repo`.
5. F4 (relocate-only) — move `parseStringArray` into `shared.ts`; reuse in captures repo. Do NOT extend to workflow-runtime's unchecked parses in this step.
6. F7 — enrich `parseJsonRecord` diagnostics (keep throwing).
7. Re-run `bun test` + `bun run typecheck` after each step.
8. Defer F5 (canonicalizer unify), F6 (outbox failed-state), and F8 (status-CHECK hardening) to human review — each is behavior/schema-affecting.

## Safety checklist

- [ ] `bun test` green before and after each step (~90 cases).
- [ ] `bun run typecheck` (tsc --noEmit) clean — exactOptionalPropertyTypes is on; F2 must preserve optional-property object shapes exactly.
- [ ] Consumer build green: `acp-server` + `acp-e2e` typecheck/test (they read `.sqlite` and discrete run columns directly).
- [ ] No change to persisted serialization for `input_attempts.fingerprint`, `workflow_events.event_hash`/`command_hash` (guards F5).
- [ ] biome lint clean — F4/F5 must not introduce a `typeof` literal dedup that trips `useValidTypeof`.
- [ ] Confirm no dirty `bun.lock` / churn-only `package.json` after apply (per repo memory: revert dev-dep timestamp churn before reporting).
