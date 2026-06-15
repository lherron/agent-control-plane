# Refactoring Analysis — `packages/acp-server`

Read-only analyst pass. No source edited. Package profile: **general** (HTTP-surface
composition package: thin route handlers over injected stores + a wrkf workflow port).
Concurrency concerns are real (in-process schedulers/dispatchers) but the shared-mutable
state is confined to per-process timers/closures in `cli.ts`, not data structures, so the
concurrent swaps (T31/T32) do not apply at the package's own seams.

## Summary

The package is in good structural health for its size (~26k LOC src). The public boundary
(`src/index.ts`) is a deliberately curated, narrow surface; routing is data-driven and
clean; handlers are thin and uniform; the wrkf/value projection layer is well factored.

The substantive findings are concentrated in **three** mechanisms:

1. **T15 / missing abstraction** — the `pbc-progressive-refinement@9` workflow ref is a
   magic string redeclared under four different constant names across six source files.
   This is also a latent safety hazard (template-pin coupling: bumping the pin requires
   editing N scattered literals).
2. **T16 / dead structure** — two re-export shim modules (`wrkf/pbc-prompt-compiler.ts`,
   `wrkf/pbc-template-model.ts`) and one unwired handler (`handlers/pending-p1-impl.ts`)
   have zero live consumers.
3. **T15 / duplicated value-reader helpers** — `isRecord`/`readRecord`/`readString`/
   `readNumber`/`readOptionalString`/`readOptionalRecord` are independently re-implemented
   in ~10 modules despite a canonical `wrkf/value.ts` and `parsers/body.ts` already existing.

Everything found is internal-only and behavior-preserving. **No High-risk or
public-surface refactor is proposed** — the deferred list is empty.

Files read in full: index, package.json, create-acp-server, http, deps, all of routing/,
route-context, middleware/actor-and-authz, parsers/{actor,body}, handlers/shared,
wrkf/{port,value,errors,projections,pbc-harness}, handlers/wrkf-pbc-* (5), pbc/routes,
launch-role-scoped, jobs/flow-engine, domain/run-store, cli, the stub/barrel files,
wrkf/CONSUMERS.md, plus targeted greps across the whole tree. ~30 files read in full.

---

## Public boundary — verdict: **sound**

`src/index.ts` re-exports exactly the consumer-facing surface: `createAcpServer`/`AcpServer`,
the CLI entrypoints, the `deps.ts` type seam (all the injectable resolver/port types),
the in-memory + durable store implementations and their interfaces, the launch helpers,
and `exactRouteKey`. `package.json#exports` maps `.` to `src/index.ts` (bun) / `dist`.

Strengths:
- Types vs values are correctly split (`export type { ... }` for the dep contracts).
- `AcpServer` is a one-method interface (`handler(Request): Promise<Response>`) — minimal,
  honest, and matches actual usage (the `cli.ts` Bun.serve `fetch` calls only `.handler`).
- `AcpHrcClient` is a `Pick<HrcClient, ...>` + two extra methods — the leaky-wide HrcClient
  is already narrowed to actual usage (good T07 already applied).
- The dep interface uses `?: T | undefined` consistently and `resolveAcpServerDeps`
  centralizes default wiring (single composition point).

Minor observations (not defects):
- `exactRouteKey` is exported from index but is an internal routing detail; it is exported
  to let external callers build the same route key for testing/middleware. Load-bearing —
  leave it.
- `DEFAULT_INTERFACE_DB_PATH` / `DEFAULT_STATE_DB_PATH` / `DEFAULT_AGENT_ASSETS_DIR` in
  `deps.ts` are absolute machine paths (`/Users/lherron/...`). These are not exported and
  are overridden by env/CLI in production, so they are dev defaults, not a boundary defect.
  Flagged for awareness only; out of scope for a behavior-preserving refactor.

No contract change (M02 Expand/Contract) is warranted: the boundary is neither fat nor leaky.

---

## Findings by mechanism (outside-in)

### F1 — [T15] Reify the PBC workflow ref as one shared constant
- **Location:** `src/wrkf/pbc-harness.ts:24,69`, `src/handlers/wrkf-pbc-inspect.ts:7,17`,
  `src/wrkf/packs/pbc/template-model.ts:10` (`PBC_WORKFLOW_TEMPLATE_REF`),
  `src/wrkf/packs/pbc/manifest.ts:16` (`PBC_WORKFLOW_REF`),
  `src/pbc/projection.ts:22` (`PBC_WORKFLOW_REF`), and the string-literal in
  `src/pbc/start.ts` derives `pbcName` from it.
- **Mechanism repaired:** duplicated intent + primitive obsession — the canonical workflow
  identity is a single domain fact (`pbc-progressive-refinement@9`) but is encoded as a bare
  string under four differently-named constants in six modules.
- **Direction:** relocate/consolidate (one exported `const`, others import it).
- **Preservation rung:** exact value equality — the consolidated constant must equal the
  current literal byte-for-byte; the `template-model.ts` ref is the natural source of truth
  (it sits next to the pinned template hash in `manifest.ts`).
- **Falsifiable signal:** `grep -rn "pbc-progressive-refinement@" src` returns exactly one
  literal occurrence after the change; all PBC route/harness/projection tests stay green.
- **Risk:** Low. **API-impact:** internal-only (none of these constants are in `index.ts`).
- **Effort:** S.
- **Tests:** existing `wrkf/pbc-harness.test.ts`, `__tests__/pbc-projection.test.ts`,
  `wrkf/packs/pbc/template-model.test.ts`, `wrkf/packs/pbc/manifest`-touching tests cover it.
- **Contraindication:** `manifest.ts` pins both the ref AND a template hash that must move
  together (see MEMORY: PBC template-pin coupling). Do NOT split the ref away from the hash;
  keep them co-located in `packs/pbc/` and import the single ref from there. The `@9` version
  suffix is meaningful — do not "parameterize" the version out into config.

### F2 — [T16] Remove dead re-export shim modules
- **Location:** `src/wrkf/pbc-prompt-compiler.ts` (`export * from './packs/pbc/prompt-compiler'`),
  `src/wrkf/pbc-template-model.ts` (`export * from './packs/pbc/template-model'`).
- **Mechanism repaired:** premature/leftover indirection from an earlier file move; the
  abstraction (a stable old import path) is no longer consumed.
- **Direction:** remove.
- **Preservation rung:** import-graph equivalence — confirmed zero live importers
  (`grep` finds only a stale comment reference inside `packs/pbc/prompt-compiler.test.ts`,
  not an import). Real code imports `./packs/pbc/...` directly.
- **Falsifiable signal:** delete both files; `tsc --noEmit` + `bun test` stay green.
- **Risk:** Low. **API-impact:** internal-only (not in `index.ts`).
- **Effort:** S.
- **Tests:** typecheck + full suite are the gate.
- **Contraindication:** verify no out-of-package importer references the old paths via a
  repo-wide grep before deleting (these are forwarding shims that were likely left for an
  external consumer). If any sibling package imports them, keep or migrate that consumer
  first (this is the only reason to treat F2 as needing a glance beyond the package).

### F3 — [T16] Remove the unwired `handlePendingP1Impl` handler
- **Location:** `src/handlers/pending-p1-impl.ts` (whole file).
- **Mechanism repaired:** dead scaffold — a 501 "not_implemented" placeholder that is never
  imported by `routing/exact-routes.ts` or `routing/param-routes.ts`, and whose own test
  (`test/pending-p1-routes.test.ts`) exercises real admin/gateway routes, not this handler.
- **Direction:** remove.
- **Preservation rung:** behavior identical — an unrouted handler cannot be reached, so
  deleting it changes no response.
- **Falsifiable signal:** delete file; `grep -rn handlePendingP1Impl src` returns nothing;
  `bun test` green (the misleadingly-named test does not reference it).
- **Risk:** Low. **API-impact:** internal-only.
- **Effort:** S.
- **Contraindication:** none material. (Optionally rename `test/pending-p1-routes.test.ts`
  to match what it actually tests — separate cleanup, not required.)

### F4 — [T15] Collapse duplicated value-reader helpers onto the canonical module
- **Location:** independent re-implementations of the same `unknown`-narrowing helpers:
  `src/cli.ts:714-734` (`readRecord`/`readString`/`readNumber`),
  `src/domain/run-store.ts:291` (`readRecord`),
  `src/handlers/interface-messages.ts:432` (`readRecord`),
  `src/handlers/ops-dashboard-shared.ts:36,41` (`readString`/`readNumber`),
  `src/real-launcher.ts:1268` (`readString`),
  `src/pbc/worker.ts:444` (`readString`),
  `src/integration/interface-run-dispatcher.ts:566` (`readString`),
  `src/delivery/interface-response-capture.ts:218` (`readOptionalString`),
  `src/handlers/runs-outbound-attachments.ts:267` (`readOptionalString`),
  `src/launch-role-scoped.ts:273,281` (`readOptionalString`/`readOptionalRecord`).
  Canonical homes already exist: `src/wrkf/value.ts` (`isRecord`/`readRecord`/
  `readOptionalString`/`readOptionalNumber`/...) and `src/parsers/body.ts` (`isRecord`/
  `readOptionalRecordField`/...).
- **Mechanism repaired:** duplicated intent — the same record/string/number narrowing logic
  is copy-pasted instead of imported.
- **Direction:** consolidate (import from `wrkf/value.ts` where signatures match).
- **Preservation rung:** behavioral equivalence per call site — **must check each local
  variant's exact predicate before substituting.** Notable divergences: several local
  `readString` treat empty string as `undefined` (`value.length > 0`) while others do not;
  `value.ts#readOptionalString` requires non-empty, `value.ts#readOptionalNumber` accepts any
  number (no `Number.isFinite` guard) whereas `cli.ts#readNumber` requires finite. These are
  NOT drop-in identical — substitute only where the predicate matches, or widen the canonical
  helper deliberately.
- **Falsifiable signal:** per-file: replace local helper with import; `tsc` + the file's
  tests green. Net deletion of duplicated function bodies.
- **Risk:** Low–Med (Med only because of the predicate-divergence trap above).
- **API-impact:** internal-only.
- **Effort:** M (touches ~10 files; do incrementally, one file per commit).
- **Tests:** existing per-module tests; `domain/run-store` and `cli` have dedicated suites.
- **Contraindication:** do NOT mechanically sed-replace — the finite/empty-string predicate
  differences are load-bearing in a few spots (e.g. `cli.ts#readNumber` finiteness gates a
  `revision` fallback). Treat `wrkf/value.ts` as the target and only fold in matching
  variants; leave genuinely-different predicates in place or add a distinct named helper.
  Note: this dedup does not touch any `typeof` literal, so the biome `useValidTypeof`
  hazard does not apply here.

### F5 — [T15] (low priority) Extract the `'x' in patch ? ... : {}` spread in `updateRun`
- **Location:** `src/domain/run-store.ts:219-268` — nine consecutive optional fields each
  expanded as `...('x' in patch ? patch.x === undefined ? {} : { x: patch.x } : {})`.
- **Mechanism repaired:** repeated boilerplate intent ("apply patch field if the key is
  present and not undefined").
- **Direction:** extract a tiny `assignDefined(patch, key)` / merge helper.
- **Preservation rung:** **exact field-set + present-but-undefined semantics.** The current
  code distinguishes "key absent" (skip) from "key present === undefined" (also skip) from
  "key present with value" (apply). Any helper MUST reproduce all three, and the resulting
  object MUST contain exactly the same keys — this is the spread/projection preservation rung.
- **Falsifiable signal:** `domain/__tests__/run-store-sqlite.test.ts` +
  `__tests__/run-store-deterministic.test.ts` green; snapshot of stored-run key set unchanged.
- **Risk:** Med (subtle three-way semantics). **API-impact:** internal-only.
- **Effort:** S.
- **Contraindication:** strong — this is the kind of "obvious" dedup that silently changes
  which keys exist on the object. The explicit form is arguably clearer/safer than a clever
  helper. Recommend leaving as-is unless the same pattern recurs elsewhere; included here for
  completeness, not as a confident win.

---

## Deliberately left alone (where-NOT)

- **`/v1/pbc/*` (product) vs `/v1/wrkf/pbc/*` (operator-debug) route families.** These look
  like duplicate surfaces but `wrkf/CONSUMERS.md` documents them as intentionally distinct:
  product consumers use `/v1/pbc/*`; `/v1/wrkf/pbc/*` is harness/operator-debug under a
  separate `wrkf.pbc.*` authz namespace (note `parseActorBody: false` on those specs). Do NOT
  collapse them — different audiences, different authorization, different response envelopes.
  `pbc-harness.ts` even self-documents as the legacy compatibility wrapper. (No T23 collapse.)

- **Thin PBC route handlers** (`wrkf-pbc-run-step.ts`, `-run-until-blocked.ts`,
  `-approve-transition.ts`, `-inspect.ts`, `-deliver-effects.ts`). Each is a deliberate,
  uniform seam: `requirePbcTaskParam` -> `requirePbcHarnessPort` -> `withPbcRouteIdempotency`
  -> harness fn. This is good substitution-seam discipline, not middle-man. Leave it.

- **`cli.ts` length (~1.1k LOC).** It is the composition root: arg parsing, default
  resolution, store opening, launcher selection, dispatcher/scheduler wiring, Bun.serve. The
  size reflects genuine wiring fan-out, not low cohesion. The PBC-worker-port builder
  (`createPbcWorkerRunner`) is the one extractable chunk, but it closes over local launch
  state and mirrors `requirePbcHarnessPort`'s shape; extracting it risks duplicating the port
  contract. Leave unless a second caller appears.

- **`http.ts#errorResponse` string-sniffing arms** (`message.includes('canonical SessionRef')`,
  `startsWith('Unknown ACP preset:')`, `startsWith('Invalid ScopeRef')`). These are T18
  error-translation smells (mapping by message text rather than typed errors) BUT the upstream
  errors come from other packages (`agent-scope`, preset registry) that throw plain `Error`.
  Fixing properly requires typed errors at the source — that is a cross-package redesign, not
  a behavior-preserving refactor here. Flagged as a known smell; intentionally NOT proposed.

- **`AcpHrcClient` `Pick<>` + extras.** Already narrowed to actual usage (T07 satisfied).

- **`deps.ts` optional-everything `AcpServerDeps` vs `ResolvedAcpServerDeps`.** The
  Expand/Resolve split (raw optional deps -> resolved-with-defaults) is the correct seam for
  a composition package; not a `T16` over-abstraction.

---

## If applying: outside-in sequence

1. **F3** (delete `pending-p1-impl.ts`) — zero blast radius; do first.
2. **F2** (delete the two shim modules) — after a repo-wide grep confirms no out-of-package
   importer.
3. **F1** (consolidate the PBC workflow ref) — single source of truth in `packs/pbc/`,
   import elsewhere; keep ref+hash co-located.
4. **F4** (fold duplicate value-readers onto `wrkf/value.ts`) — one file per commit, checking
   each predicate; this is the largest-surface change, do last and incrementally.
5. **F5** — recommend skipping; only if you have spare budget and add a tight snapshot test
   on the stored-run key set first.

## Safety checklist

- [ ] Make-safe (T40): no characterization gap — the package has dense existing tests
      (`test/` + `src/__tests__/`); run `bun test` before and after each finding's commit.
- [ ] `tsc --noEmit` clean after each change.
- [ ] F1: `grep -rn "pbc-progressive-refinement@" src` == 1 literal; ref and template hash
      still co-located in `packs/pbc/`.
- [ ] F2: repo-wide grep for the old shim paths from OUTSIDE this package returns nothing
      before deletion.
- [ ] F3: `grep handlePendingP1Impl src` empty; `pending-p1-routes.test.ts` still green.
- [ ] F4: per-file, confirm the local helper's empty-string / `Number.isFinite` predicate
      matches the canonical helper before substituting; no `typeof`-literal dedup introduced.
- [ ] F5: if attempted, stored-run key-set snapshot unchanged (present-but-undefined skipped).
- [ ] No changes to `src/index.ts` exports (boundary is sound — keep it frozen).
