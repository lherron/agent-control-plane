# acp-core — Refactoring Analysis

Package: `packages/acp-core`
Profile: **general domain library** with a strongly **data/event-sourced** sub-module (`workflow/`, `learning/`) and a **validation/parser** sub-module (`webhook/`). Pure (no network/db); the only side-effecting primitive is `node:crypto` hashing. No concurrency. Leaf-ish but **has many external consumers** (`acp-server`, `acp-jobs-store`, `acp-interface-store`, `gateway-discord`, `wlearn`), so M02 Expand/Contract applies to any public-contract change — this is NOT a drop-M02 leaf.

Files read in full: 38 source files under `packages/acp-core/src/` plus `package.json`, `README.md`, and the test inventory (`src/__tests__/`, `test/`). 107 `test()` cases exist.

## Summary

The package is in good shape. It is mostly immutable type declarations plus small pure helpers, with one very large hand-rolled event-sourced kernel (`workflow/index.ts`, 3434 lines). Characterization coverage is strong (107 tests across kernel, webhook, presets, transitions, interface, actor). Most "magic number / duplication" smells are already factored into `internal/` helpers or named constants.

The highest-leverage findings are at the **public boundary**: one type that an external consumer already imports is **not exported** (`DeliveryOutcome`), and two webhook symbols are exported/defined but **dead** (`wrkq-event.ts:isAgentOriginEvent`, `normalizeAgentActor`). After that, the remaining items are internal de-abstraction / dedup of small helpers, all behind the existing test wall.

## Public boundary (assess first) — verdict: **needs-care**

`src/index.ts` is a flat, alphabetized re-export hub (254 lines). It is mostly disciplined: value exports and `type` exports are separated, and module groupings mirror the directory tree. Issues:

1. **Leaky boundary — missing export (real defect).** `gateway-discord/src/tests/write-plan.test.ts:2` does `import type { DeliveryOutcome, DeliveryRequest } from 'acp-core'`, but `DeliveryOutcome` (defined `src/interface/delivery-request.ts:12`) is **not** re-exported by `index.ts` and is **absent from `dist/index.d.ts`**. The consumer's `import type` currently resolves to `any`/error rather than the real union. This is a genuine align-to-usage gap.

2. **Fat boundary — dead exports.** `webhook/index.ts` and `index.ts` export `normalizeAgentActor` and (via `acp-event.js`) `isAgentOriginEvent`. The acp-event `isAgentOriginEvent` (on `AcpWebhookEvent`) is the live one (used by `acp-server/src/jobs/event-job-evaluator.ts` and `acp-jobs-store` tests). But `wrkq-event.ts:isAgentOriginEvent` (line 98, on `WrkqWebhookEvent`) has **zero callers anywhere** (it is not even re-exported — the barrel re-exports only the acp-event version), and `normalizeAgentActor` has **zero consumers** outside its own definition.

3. **`hashValue` asymmetry (deliberate, fine).** `internal/canonical-json.ts` exports `hashValue`, `sortJson`, `stableJson`; only `stableJson` is surfaced publicly (re-exported through `workflow/index.ts`). `hashValue`/`sortJson` are correctly kept internal. No action.

Everything else on the boundary maps cleanly to actual usage. Verdict **needs-care** solely because of items 1 and 2.

## Findings by mechanism (outside-in)

### A. Make-safe (gates everything)

**F0 — [T40] Characterization tests already cover the surface.** No new gating tests required before the internal items below. Coverage exists for: workflow kernel event-sourcing/obligations/supervisor/participant (`src/__tests__/workflow-*.test.ts`), webhook parse/match/resolve (`src/__tests__/webhook.test.ts`), presets + transition policy + task-context + interface binding + actor precedence (`test/*.test.ts`). The one **gap** worth adding before touching the boundary: a compile/type assertion that `DeliveryOutcome` is importable from the package root (today nothing in-package imports it). Risk Low, internal-only (test-only).

### B. Boundary (highest leverage)

**F1 — [T07] Add missing public export `DeliveryOutcome`.**
- Location: `src/index.ts:88-93` (the `delivery-request.js` `export type {...}` block) — defined at `src/interface/delivery-request.ts:12`.
- Mechanism repaired: boundary under-exposes a type the contract already promises; an external consumer (`gateway-discord`) imports it from `'acp-core'`. Narrow/leaky export not aligned to actual usage.
- Direction: **add** `DeliveryOutcome` to the `delivery-request.js` type re-export.
- Preservation rung: pure additive type export — no value, no field change. Same field set preserved (the union is re-exported verbatim).
- Falsifiable signal: `grep DeliveryOutcome dist/index.d.ts` returns a hit after build; `gateway-discord` test type-resolves `DeliveryOutcome` to the real union (not `any`).
- Risk: Low. API-impact: **public-surface** (additive). Effort: trivial. Tests: build + gateway-discord typecheck.
- Contraindication: none. (Additive; M02 add-new step only — no removal.)

**F2 — [T16/T23] Remove dead webhook export `wrkq-event.ts:isAgentOriginEvent`.**
- Location: `src/webhook/wrkq-event.ts:98-101`. The barrel (`webhook/index.ts`) already does NOT re-export it; the live `isAgentOriginEvent` is `acp-event.ts:217` (on `AcpWebhookEvent`). The wrkq version (on `WrkqWebhookEvent`) has zero callers in `src`, no re-export, and no external consumer.
- Mechanism repaired: premature duplication — two same-named predicates for two event shapes, but the pipeline always adapts wrkq→acp before the agent-origin check, so the wrkq variant never fires.
- Direction: **remove** the function (and its now-unreferenced doc).
- Preservation rung: behavior-preserving — removing a symbol with no readers. The `acp-event.ts:isAgentOriginEvent` path is unchanged.
- Falsifiable signal: `grep -rn "isAgentOriginEvent" src/webhook/wrkq-event.ts` empty; `bun test` green; `acp-jobs-store`/`acp-server` typecheck unchanged.
- Risk: Low. API-impact: **internal-only** (not on the package barrel — `webhook/index.ts` never re-exported it). Effort: trivial. Tests: package test suite.
- Contraindication: confirm no deep import path (`acp-core/.../wrkq-event`) elsewhere; grep shows none.

**F3 — [T23] Drop dead public export `normalizeAgentActor` (or wire it).**
- Location: defined `src/webhook/wrkq-event.ts:108-110`; re-exported `webhook/index.ts:2` and `index.ts:224`.
- Mechanism repaired: fat boundary — a public symbol with no consumer anywhere in the monorepo (grep across all packages, excluding its own definition, returns nothing).
- Direction: **remove** from the boundary (and the function) — OR intentionally keep if it is a planned wrkq/job actor-comparison seam. Mark direction honestly: this is a *removal* candidate, not "extract more".
- Preservation rung: removing a never-imported export. Public-surface because it sits on the package root, but no observed consumer.
- Falsifiable signal: after removal `bun run typecheck` across dependents stays green; `grep -rn normalizeAgentActor packages` (excl. acp-core/src, dist) stays empty.
- Risk: **Med** (public-surface removal; could be reserved for an unlanded caller). API-impact: **public-surface**. Effort: low. Tests: monorepo typecheck.
- Contraindication: if this is an intentional API seam for upcoming job/agent actor reconciliation, keep and add a consumer/test instead of deleting. Needs a human decision — deferred.

### C. Seams & structure

**F4 — [T16] Collapse duplicate private `isRecord` in `models/actor.ts`.**
- Location: `src/models/actor.ts:23-25` duplicates `src/internal/guards.ts:1-3` (identical predicate; the webhook modules already import the `internal/guards` one).
- Mechanism repaired: duplicated intent — two definitions of the same type guard, one private. De-abstract the local copy by importing the shared one.
- Direction: **relocate/dedup** — import `isRecord` from `../internal/guards.js`, delete the local function.
- Preservation rung: same predicate semantics (`typeof === 'object' && !== null` — note `guards.ts` additionally excludes arrays via `!Array.isArray`; for actor parsing an array `candidate` then fails the subsequent `kind`/`id` checks and is rejected anyway, so observable behavior is preserved — but **verify this in a test** since it is a subtle widening of the reject path, not a no-op). Field set untouched.
- Falsifiable signal: `actor.test.ts` + `actor-precedence.test.ts` stay green, including any array-body case.
- Risk: **Med** (the two guards are not byte-identical — array handling differs; must confirm no actor test passes an array that previously slipped through). API-impact: internal-only. Effort: low. Tests: actor suites.
- Contraindication: if any actor input legitimately is array-shaped and must be treated as a record, do not merge. (None found.)

**F5 — [T15/T16] Two `actorKind` helpers — leave separate (where-NOT, see below).** Pressure-tested: NOT a safe dedup. `acp-event.ts:47` returns the validated union `'human'|'agent'|'system'|undefined`; `event-match.ts:99` returns the **raw** prefix string (e.g. returns `"foo"` for `"foo:bar"`). Merging would change `event-match.ts`'s `matchesOrigin` semantics (it compares the raw kind against `match.kind`). Do **not** parameterize — divergent contracts. Listed under "Deliberately left alone."

**F6 — [T16] Two `deepFreeze` implementations — leave separate.** `models/preset.ts:56` returns a typed `DeepReadonly<T>` and is cycle-safe via `WeakSet`; `workflow/index.ts:476` is an untyped internal recursive freeze used on cloned definitions. They differ in type contract and cycle handling. Consolidating onto the `models/preset` version inside the kernel is *possible* but would couple the kernel to the preset module and change the freeze's typing; low payoff, real churn. Left alone (see below).

### D / E. Invariants, quality

**F7 — [T16] `learning/index.ts` `runDeterministicWorkflowReplay` accepts an unused `now` only at the type level.** `runDeterministicWorkflowReplay`'s input declares `now?` but it is also referenced (`createdAt: input.now ?? new Date().toISOString()`), so it IS used — re-read confirms NOT dead. No action. (Recorded to document the pressure-test: the apparent dead param is live.)

**F8 — [T22] `submitControlAction` / `applyTransition` are flagged `noExcessiveCognitiveComplexity` (biome-ignored).** `workflow/index.ts:1450` and `:1626` are large dispatchers (one arm per control-action / guard layer). This is a candidate for **[T19] conditional→dispatch** (table of `action.type` → handler) which would let the biome-ignore be removed. However: each arm closes over the kernel's private maps (`tasks`, `obligations`, `events`, `nextId`, `appendEvent`, …), so extracting handlers means threading a large context object or moving them inside the closure — high churn, high regression surface, and the existing biome-ignore documents a deliberate "central checked dispatcher" choice.
- Direction: dispatch-table extraction (remove the long `if (action.type === …)` ladder).
- Preservation rung: must preserve exact event-append order, idempotency wrapping, and clone boundaries — these are observable in `workflow-event-sourcing.test.ts` (event hashes/`prevHash` chain).
- Falsifiable signal: event-sourcing replay tests (hash chain) stay green; biome no longer needs the ignore.
- Risk: **High** (touches the event-hash chain and idempotency; behavior-preserving is hard to guarantee mechanically). API-impact: internal-only (kernel internals). Effort: high. Tests: full `workflow-*` suite.
- Contraindication: load-bearing ordering + deliberate central-dispatcher annotation. Deferred — do not auto-apply.

**F9 — [T26/perf] `clone<T>` via `JSON.parse(JSON.stringify())` is the kernel's deep-copy primitive (`workflow/index.ts:472`), called on nearly every read/write.** This is a real perf seam, but it is **load-bearing**: it both deep-copies AND strips `undefined` keys, which the canonical event-hashing depends on for deterministic hashes. Replacing it with `structuredClone` would change `undefined`-key handling and could perturb `eventHash`/`contextHash` values — that is a **behavior change**, not a refactor. Flag as redesign, not auto-apply. Left alone unless the team wants a measured, separately-tested swap.

## Deliberately left alone (where-NOT)

- **F5 `actorKind` (two copies):** divergent return contracts (validated union vs raw prefix). Merging changes `matchesOrigin` matching semantics. Keep both.
- **F6 `deepFreeze` (two copies):** different type contracts + cycle handling; consolidation couples kernel↔preset module for negligible gain.
- **F9 `clone` JSON round-trip:** load-bearing `undefined`-stripping feeds deterministic hashing; swapping primitives is a behavior change.
- **F8 kernel dispatchers:** deliberate central checked-dispatcher (documented biome-ignore); extraction risks the event-hash chain.
- **`(string & {})` open unions** on `TaskLifecycleState`/`RiskClass` (`models/task.ts:3,10`): intentional "known values + open extension" pattern, not primitive obsession. Keep.
- **Preset data files** (`presets/*.v1.ts`): large literal transition tables are data, not duplicated logic. `code_feature_tdd` has 3 parallel `accepted→released` rules differing only by evidence kind — this is intended policy (any-of release proof), not a dedup target.
- **`internal/canonical-json.ts` selective export:** `hashValue`/`sortJson` correctly internal. Keep.

## If applying: outside-in sequence

1. **F1** add `DeliveryOutcome` to `index.ts` (additive, unblocks gateway-discord). Build, confirm `dist/index.d.ts`.
2. **F0** add a one-line type-import smoke test for `DeliveryOutcome` from the package root.
3. **F2** delete dead `wrkq-event.ts:isAgentOriginEvent`. Run `bun test` + dependents typecheck.
4. **F4** dedup `isRecord` in `models/actor.ts` onto `internal/guards.ts` — only after confirming no actor test feeds an array body; run actor suites.
5. **F3** decide `normalizeAgentActor` (remove vs keep+wire) — needs human call; do not bundle with auto-apply.
6. Leave F5/F6/F8/F9 for a separately-scoped, individually-tested redesign pass.

## Safety checklist

- [ ] `bun test` (acp-core) green before and after each change.
- [ ] `bun run typecheck` across dependents (`acp-server`, `acp-jobs-store`, `acp-interface-store`, `gateway-discord`, `wlearn`) green.
- [ ] `bun run build` regenerates `dist/index.d.ts`; confirm `DeliveryOutcome` present, `normalizeAgentActor` change reflected.
- [ ] F4: verify array-shaped actor input handling unchanged (add/keep a test).
- [ ] No deep-import (`acp-core/src/...` / `acp-core/dist/...`) of removed symbols across the monorepo (grep).
- [ ] biome lint clean (no new `useValidTypeof` from any dedup; F4/F2 do not parameterize a `typeof` literal).
- [ ] No churn to `bun.lock` / `package.json` dev-dep timestamps left in the change.
