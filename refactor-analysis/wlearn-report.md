# Refactor analysis: `packages/wlearn`

## Summary

`wlearn` is a tiny **leaf package** (~250 LOC of source): a thin CLI (`src/cli.ts`) plus a pure re-export facade (`src/index.ts`) over `acp-core`'s learning module. Profile: **leaf** (no internal consumers found anywhere in `packages/*`; the only external consumption is its `bin` entry). Per the leaf profile, **M02 Expand/Contract is dropped** — there are no downstream importers to migrate, so public-contract changes can be done in place.

The code is clean, deliberately structured (handler-per-command, validation helpers), and most of it is intentionally read-only/stateless by design (the package's whole point is that it "never owns workflow lifecycle state" — see the test and the `note` fields). There are **no concurrency, data-store, or perf hot paths**. Findings are modest and mostly **internal-only Low risk**: one premature-dispatch cleanup, one dead re-export, one parser correctness edge, and one duplicated entrypoint/error-handling block between `bin/wlearn.js` and `src/cli.ts`.

No High-risk behavior changes are required. The one item with **public-surface** impact is trimming unused re-exports from `index.ts` (the package's library surface), which is deferred for human confirmation even though no consumer exists.

- Files read in full: `src/index.ts`, `src/cli.ts`, `src/__tests__/cli.test.ts`, `bin/wlearn.js`, `package.json`.
- Cross-checked: re-exported symbols all resolve in `packages/acp-core/src/learning/index.ts`; no `from 'wlearn'` importers anywhere in the repo.

## Public boundary (assessed first)

The package exposes **two** surfaces:

1. **Library surface** — `src/index.ts` (mapped via `package.json` `exports["."]`). It re-exports 5 functions and 7 types verbatim from `acp-core`. Verdict for this file in isolation: **leaky/needs-care**.
   - Of the 5 re-exported functions, the CLI uses only 3 (`materializeWorkflowTrace`, `runDeterministicWorkflowReplay`, `validatePromotionReadiness`). `reviewTraceLabel` and `transitionLearningArtifactLifecycle` are re-exported but used by **no code in this package and no external consumer in the repo**. This is a pass-through middle-man (T23) that widens the surface beyond actual usage (T07).
   - Because nothing in the monorepo imports `wlearn`, this facade is currently **dead surface**. It is plausibly a deliberate "public API of the learning toolkit" facade, so it is flagged needs-care rather than auto-removed.

2. **CLI surface** — `runWlearnCli(argv)` exported from `src/cli.ts`, driven by `bin/wlearn.js`. Verdict: **sound**. The command grammar is explicit, every handler validates required flags, unknown commands throw (characterized by the one existing test), and the "we never own lifecycle state" invariant is encoded in `note` fields and the readiness/replay calls that delegate to `acp-core`.

Overall boundary verdict: **needs-care**, driven entirely by the unused re-exports in `index.ts`. The CLI contract itself is well aligned to usage.

## Findings by mechanism (outside-in)

### F1 — Dead/leaky library re-exports (boundary)
- **Location:** `packages/wlearn/src/index.ts:3-4` (`reviewTraceLabel`, `transitionLearningArtifactLifecycle`).
- **Technique:** [T07] align interface to actual usage (narrow fat export); supported by [T23] remove middle man.
- **Mechanism repaired:** the package's public surface is wider than any actual consumer (including its own CLI). Narrowing it makes the facade describe what `wlearn` actually offers instead of mirroring an arbitrary subset of `acp-core`.
- **Direction:** remove (narrow).
- **Preservation rung:** leaf package, **M02 dropped** — no importers to support-both/migrate. The change is observable only to a hypothetical future importer.
- **Falsifiable signal:** `grep -rn "from 'wlearn'" packages` returns nothing (verified); after removal, `tsc --noEmit` and `bun test` still pass.
- **Risk:** Low (mechanically), but **API-impact: public-surface** — it is the library export boundary, so it is **deferred** for human confirmation rather than auto-applied.
- **Effort:** trivial (delete 2 function names + any now-unused type re-exports if they become orphaned; the 7 type re-exports are independent and should be left unless a human confirms intent).
- **Tests:** existing typecheck + `cli.test.ts`; no new test needed.
- **Contraindication:** if `index.ts` is intentionally the curated "learning toolkit" public API (a facade meant to be stable regardless of current internal use), keep all 5 functions. This is why it is deferred, not applied.

### F2 — Premature `if/return` dispatch ladder for command routing
- **Location:** `packages/wlearn/src/cli.ts:155-199` (`runWlearnCli`, the seven `if (key === ...) { handlerX(flags); return }` blocks).
- **Technique:** [T19] conditional -> dispatch.
- **Mechanism repaired:** a flat string-keyed switch that grows exactly one new `if` block per command. The variation axis is "command name -> handler", which is data; expressing it as a `Record<string, (flags) => void>` lookup table collapses seven near-identical branches into one dispatch and one fall-through.
- **Direction:** relocate/restructure (conditional -> dispatch table).
- **Preservation rung:** behavior-preserving — same command keys, same handlers, same `usage()`/unknown-command fall-through ordering must be retained (empty/`help`/`--help` -> `usage()`; otherwise throw `unknown wlearn command`).
- **Falsifiable signal:** `cli.test.ts` still asserts `runWlearnCli(['promotion','promote'])` throws `unknown wlearn command`; a help-path assertion (currently absent) would also hold.
- **Risk:** Low. **API-impact: internal-only.**
- **Effort:** small.
- **Contraindication:** the ladder is only 7 arms and each is one line; dispatch is a wash on size and mainly helps if more commands are expected. Honor the ordering subtlety: the `help`/empty check happens **after** the command checks, so the table must preserve "miss -> check help -> throw". If the team prefers the explicit ladder for readability, this is a legitimate where-NOT.

### F3 — `parseArgs` rejects negative-number / `--`-prefixed flag values
- **Location:** `packages/wlearn/src/cli.ts:16-23`.
- **Technique:** [T17] partial -> total (input handling) / [T18] restructure error handling.
- **Mechanism repaired:** the parser treats any token starting with `--` as a flag, and any next-token starting with `--` as "missing value". For the current command set all values are file paths, ids, JSON, `kind:id`, or seqs, so this is **not currently reachable** with valid input — but it is a latent partiality: a value that legitimately starts with `--` (or a negative seq like `-5` is fine; `--`-prefixed is the gap) is mis-classified.
- **Direction:** isolate/total (only if a real need appears).
- **Preservation rung:** behavior-changing for inputs that currently throw, so it is a **redesign, not a refactor** — do not auto-apply.
- **Falsifiable signal:** no current command passes a `--`-leading value, so no existing test exercises it; adding one would be the signal.
- **Risk:** Low severity but **flagged High-discipline / public-surface** because it changes observable CLI input acceptance (a contract change), so it is **deferred**.
- **Effort:** small.
- **Contraindication:** the strict parser is arguably a feature (catches a dropped value). Leave unless a concrete command needs `--`-leading values.

### F4 — Duplicated entrypoint + error-handling shim between `bin/wlearn.js` and `src/cli.ts`
- **Location:** `packages/wlearn/bin/wlearn.js:4-10` duplicates `packages/wlearn/src/cli.ts:201-209` (the `try { runWlearnCli() } catch { stderr + exit(1) }` block).
- **Technique:** [T15] extract missing abstraction (de-duplicate intent) / [T23] collapse pass-through.
- **Mechanism repaired:** the "run CLI, print error to stderr, exit 1" wrapper exists twice. The `import.meta.main` block in `cli.ts` and the `bin` shim are two copies of the same top-level harness. One could export a `main()` from `cli.ts` and have both call it, or have `bin/wlearn.js` simply import and the `import.meta.main` guard handle it.
- **Direction:** remove (collapse to one harness).
- **Preservation rung:** behavior-preserving — same stderr message, same exit code. Note the bin imports `../src/cli.ts` directly (bun shebang), while `import.meta.main` only fires for direct execution; collapsing must keep the bin path working under `bun`.
- **Falsifiable signal:** running `wlearn` with a bad command still prints the message to stderr and exits 1; `cli.test.ts` unaffected (it tests the thrown error, not the harness).
- **Risk:** Low. **API-impact: internal-only** (the `bin` invocation contract — stderr + exit 1 — is preserved).
- **Effort:** small.
- **Contraindication:** the duplication is tiny (6 lines) and the two entrypoints have slightly different module-resolution contexts (`.ts` direct vs `import.meta.main`). Collapsing adds an export to the public-ish module surface; the saving is marginal. Reasonable where-NOT.

### F5 — Magic authority-tier constants are local, not shared with `acp-core`
- **Location:** `packages/wlearn/src/cli.ts:63-64` (`PLAYBOOK_AUTHORITY_TIER = 2`, `PATCH_AUTHORITY_TIER = 3`).
- **Technique:** [T15] extract missing abstraction (named constant) — **already partially done**; the smell is that these tiers are *redeclared* here rather than sourced from `acp-core`.
- **Mechanism repaired:** the numbers are already named (good), but the authority-tier taxonomy plausibly lives in `acp-core`'s learning domain. If so, redeclaring `2`/`3` here is a duplicated invariant that can drift.
- **Direction:** relocate (import from `acp-core` if a canonical tier enum/const exists there).
- **Preservation rung:** behavior-preserving only if the `acp-core` values match exactly.
- **Falsifiable signal:** grep `acp-core` for an authority-tier definition; if one exists with values 2/3, importing it removes the drift. (Not confirmed present — these may be wlearn-local draft conventions.)
- **Risk:** Low. **API-impact: internal-only.**
- **Effort:** trivial-if-source-exists; otherwise leave.
- **Contraindication:** these draft handlers emit advisory JSON (`lifecycle: 'draft'`, `note: ...`) that `acp-core` re-validates on ingest; the tiers here may be intentionally local placeholders. Do not invent a shared constant if none exists.

## Deliberately left alone (where-NOT)

- **`src/index.ts` type re-exports (lines 8-16):** 7 type re-exports. These are zero-cost at runtime and form the type vocabulary a future importer would need alongside the functions. Leave intact even if F1 trims functions, unless a human confirms full-facade removal.
- **`note`/advisory string fields in draft/curate/promotion handlers:** these encode the package's core invariant ("wlearn never owns lifecycle state / never deletes raw records"). They look like dead strings but are the contract; do not "clean up."
- **`readJsonFile`, `requireFlag`, `parseActor`, `parsePatchBundle`, `printJson` helpers:** already the right small abstractions, single-purpose, used 2+ times each (`requireFlag`, `printJson`) or encapsulating a parse contract. No T16 de-abstraction warranted.
- **`parseActor` literal-union check (lines 45-49):** validates `kind` against the four `ActorRef` kinds inline. Tempting to dedupe into an array `.includes`, but that would lose the type-narrowing the explicit `===` chain gives TypeScript, and could trip lint. Leave.
- **No T40 characterization-test expansion proposed as a finding** because the package is trivially small and stateless; the existing one-line unknown-command test plus typecheck adequately gate the Low-risk internal items. (Adding a help-path and a happy-path JSON-shape test is advisable *before* applying F2, listed in the sequence below.)

## If applying: outside-in sequence

1. **Make-safe first:** add two characterization tests to `cli.test.ts` — (a) `help`/empty argv throws the usage string; (b) one happy path (e.g. `hrc summarize-range`) prints the expected JSON shape to stdout. This gates F2/F4. (Low risk, internal-only.)
2. **F2** — convert the routing ladder to a dispatch table (internal-only, gated by step 1).
3. **F4** — collapse the duplicated harness (internal-only, gated by step 1).
4. **F5** — only if a canonical `acp-core` authority-tier source is confirmed; relocate constant.
5. **Defer to human:** F1 (public surface), F3 (CLI input contract change). Do not auto-apply.

## Safety checklist

- [ ] `bun test` green (existing + any added characterization tests).
- [ ] `tsc --noEmit` (typecheck) clean — critical for F1, since it touches the typed export surface.
- [ ] `bun run build` (tsc emit) clean; `dist/` shapes unchanged for non-F1 items.
- [ ] `wlearn help`, `wlearn <bad cmd>`, and one happy command verified via the `bin` shim under `bun` (covers F4's two module-resolution contexts).
- [ ] Confirm no `from 'wlearn'` importers appeared (re-run grep) before treating F1 as applied.
- [ ] biome/lint clean — watch `parseActor` if anyone touches the kind-union check.
