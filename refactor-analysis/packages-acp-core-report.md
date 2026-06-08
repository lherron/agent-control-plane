# Refactor Analysis — `packages/acp-core`

Methodology: SOLID + code-smell audit (ANALYSIS ONLY — no source mutated).
Scope: `packages/acp-core/src/**/*.ts`, excluding `__tests__/` and `*.test.ts`.
Total non-test source lines analyzed: **7,262**.

---

## Scorecard

| Dimension | Grade | Notes |
|---|---|---|
| SRP (Single Responsibility) | D | `workflow/index.ts` is a 3,456-line "god module" — the entire in-memory kernel (types, hashing utils, 25+ closures, store, event log, context compilers) lives in one closure. |
| OCP (Open/Closed) | C | `submitControlAction` is a ~600-line `if (action.type === ...)` ladder; `materializeTransitionEffect` and `getControlActionCapabilityError` are type-keyed dispatch. Adding an action/effect = editing the dispatcher. |
| LSP | A | No inheritance hierarchies / no `throw new Error("not implemented")` overrides found. |
| ISP (Interface Segregation) | C | `WorkflowEvent` (~28 optional fields), `EvidenceRecord` (~20 fields), `SupervisorCapabilities` (13 booleans) are fat, partly-populated interfaces. |
| DIP (Dependency Inversion) | B | Kernel is mostly pure/in-memory; few hard `new Concrete()` collaborators. Coupling is via direct closure capture rather than injected ports. |
| Duplication | C | `stableJson`/`sortJson`/`hashValue` are byte-identical in `workflow/index.ts` and `learning/index.ts`; `isRecord` triplicated; participant-run lifecycle mutators are 4 near-identical copies. |
| Naming / Readability | B | Names are clear and intention-revealing; the problem is volume, not naming. |
| Test coverage signal | B | Substantial `__tests__/` suite (event-sourcing, obligation lifecycle, supervisor actions) — good safety net for refactors. |

---

## Priority Refactorings

### P1 — Extract shared canonical-JSON / hashing utility (duplication, SRP)
`workflow/index.ts:470-493` and `learning/index.ts:149-172` contain **byte-identical** `stableJson` / `sortJson` / `hashValue`. `isRecord` is independently re-declared in `webhook/job-trigger.ts:67`, `webhook/wrkq-event.ts:58`, and `models/actor.ts:23`.
- Impact: 3 copies of hash-canonicalization logic that MUST stay in lockstep (any divergence silently changes `eventHash`/`traceId` and breaks replay verification).
- Risk: Low. Pure functions, identical bodies. Extract to a `src/internal/canonical-json.ts` and re-import.
- Effort: Low.

### P2 — Decompose the `workflow/index.ts` kernel module (SRP)
The single `createInMemoryWorkflowKernel` closure (lines 622–3456) owns: store maps, snapshot hydration, event append + hash chaining, idempotency, transition evaluation, effect materialization, supervisor context compilation, participant context compilation, and 9 run-lifecycle commands.
- Impact: 3,456 lines in one file; ~2,800 inside one closure. Hard to test in isolation, hard to navigate, high merge-conflict surface.
- Risk: Medium–High (touches public kernel factory + event hashing). NOT behavior-preserving as a unit; must be done as a sequence of pure-extract steps each verified against the test suite.
- Effort: High.

### P3 — Replace `submitControlAction` if/else ladder with an action-handler table (OCP, long method)
`workflow/index.ts:1632-2248` — a single ~600-line function dispatches 9 control-action variants via sequential `if (action.type === '...')` blocks, after ~80 lines of shared guard code.
- Impact: Cognitive-complexity hotspot (already carries a `biome-ignore noExcessiveCognitiveComplexity`). Adding an action means editing the monolith; per-action logic can't be unit-tested directly.
- Risk: Medium. Behavior-affecting (control flow, early returns, event ordering). Not behavior-preserving.
- Effort: Medium–High.

### P4 — Collapse the 4 duplicated participant-run lifecycle mutators (duplication)
`markParticipantRunRunning` (3238), `completeParticipantRun` (3263), `failParticipantRun` (3308), `cancelParticipantRun` (3357) share an identical "scan all tasks → find run by id → patch status → append event" skeleton, differing only in the status/patch/event payload.
- Impact: ~120 lines of structural duplication; bug-fixes (e.g. the `continue`-on-missing-task scan) must be applied 4×.
- Risk: Medium (each appends events / mutates store). Not behavior-preserving.
- Effort: Medium.

### P5 — Extract a `findParticipantRunById` helper for the repeated cross-task scan
The `for (const [taskId, runs] of participantRuns.entries()) { const idx = runs.findIndex(...) }` pattern recurs in all 4 lifecycle mutators plus `apply_transition` evidence derivation.
- Impact: Same lookup logic, copy-pasted 5+ times.
- Risk: Low–Medium (pure read helper; extraction is mechanical but the surrounding mutation is not).
- Effort: Low.

---

## Code Smells

| # | Location | Smell / Principle | Detail |
|---|---|---|---|
| 1 | `workflow/index.ts:470-493` + `learning/index.ts:149-172` | Duplication | Identical `stableJson`/`sortJson`/`hashValue`. |
| 2 | `webhook/job-trigger.ts:67`, `webhook/wrkq-event.ts:58`, `models/actor.ts:23` | Duplication | `isRecord` type-guard declared 3×. |
| 3 | `workflow/index.ts:1632-2248` | Long method / OCP | `submitControlAction` ~600 lines, type-keyed `if` ladder. |
| 4 | `workflow/index.ts:1460-1630` | Long method | `applyTransition` ~170 lines, multiple repeated `rejectAndRecord` blocks. |
| 5 | `workflow/index.ts:2025-2201` | Deep nesting / long method | `apply_transition` branch nests loops + 4-deep conditionals deriving role/actor from evidence. |
| 6 | `workflow/index.ts:966-1044` | OCP | `materializeTransitionEffect` keyed on `template.type` via sequential `if` returns. |
| 7 | `workflow/index.ts:593-620` | OCP | `getControlActionCapabilityError` maps action.type→capability via inline object literal. |
| 8 | `workflow/index.ts:3238-3395` | Duplication | 4 near-identical run-lifecycle mutators. |
| 9 | `workflow/index.ts:2591-2686` | Long method / duplication | `validateAttachEvidenceProvenance` repeats the same actor/task-ownership check shape ~6×. |
| 10 | `learning/index.ts:226-229`, `339`, `452` | Magic number | `.slice(7, 19)` (strip `sha256:` prefix + 12-char id) repeated 3× with no named constant. |
| 11 | `learning/index.ts:252-287` | Primitive obsession / long method | `metrics` object built inline with ~14 `count(...)` calls using stringly-typed `event.type.includes(...)`/`startsWith(...)` predicates. |
| 12 | `workflow/index.ts:235-262` | Fat interface (ISP) | `WorkflowEvent` has ~28 fields, most optional and populated per-event-type. |
| 13 | `workflow/index.ts:177-200` | Fat interface (ISP) | `EvidenceRecord` ~20 fields. |
| 14 | `workflow/index.ts:19-33` | Fat interface (ISP) | `SupervisorCapabilities` = 13 optional booleans (capability-flag bag). |
| 15 | `workflow/index.ts:362-388` | Primitive obsession | `WorkflowRejectionCode` is a 25-member string union duplicating concepts in `models/transition.ts` `TransitionRejectionCode`. |
| 16 | `workflow/index.ts:1796-1859` vs `1885` / `nextTaskAfterObligationClosed:1258` | Duplication | `satisfy_obligation` inlines the "stillBlocked → resume waiting" computation that `nextTaskAfterObligationClosed` already encapsulates and `waive`/`cancel`/`expire` reuse. |
| 17 | `workflow/index.ts:962` | Dead/placeholder branch | `case 'all_child_tasks_closed': return true` — unconditional stub; `childTasks: []` (2516) is likewise hardcoded empty. |
| 18 | `webhook/job-trigger.ts:113-198` | Long method | `validateEventMatch` ~85 lines of repeated `if (value[k] !== undefined) { typecheck else errors.push }` blocks. |

---

## Quick Wins (low risk, high signal)

1. **Extract `stableJson`/`sortJson`/`hashValue`** into one internal module and import from both kernel and learning (smell #1). Pure, identical — behavior-preserving.
2. **Extract a shared `isRecord` type-guard** into a small `internal/guards.ts` (smell #2). Pure — behavior-preserving.
3. **Name the hash-slice magic numbers** in `learning/index.ts` — e.g. `const SHORT_ID = (h: string) => h.slice(7, 19)` (strip `sha256:`), reused 3× (smell #10). Same values — behavior-preserving.
4. **Reuse `nextTaskAfterObligationClosed`** inside the `satisfy_obligation` branch instead of re-deriving the resume logic inline (smell #16) — note: only behavior-preserving if the inlined and helper logic are proven equivalent first; flagged non-preserving below to be safe.

---

## Tech Debt

- **God module**: `workflow/index.ts` concentrates the entire durable-workflow contract + runtime in one closure. As the workflow surface grows (child tasks, timers — currently stubbed at lines 962/2516), this file will keep accreting. Splitting types (`workflow/types.ts`), the store, the event log, and the context compilers is the structural fix behind P2.
- **Two parallel transition systems**: `validators/transition-policy.ts` (preset/phase-graph model, `TransitionRejectionCode`) and `workflow/index.ts` (`WorkflowDefinition`/`WorkState`, `WorkflowRejectionCode`) encode overlapping concepts (SoD, evidence requirements, version conflict) with separate rejection-code unions. `workflow/definitions.ts` bridges presets→workflow defs, so the duplication is intentional during migration — but it doubles the maintenance surface for any policy-semantics change.
- **Stringly-typed event taxonomy**: metrics + correlation logic in `learning/index.ts` matches on `event.type.includes('transition')` / `.startsWith('supervisor')`. A typed event-kind enum would make the learning layer robust to event-name changes in the kernel.
- **Capability-flag bag**: `SupervisorCapabilities` (13 booleans) + the parallel `getControlActionCapabilityError` map mean every new control action touches three places (the union, the capabilities interface, the capability map).

---

## Safety Checklist (for the apply stage)

- [ ] Run the full `__tests__/` suite before and after EACH extraction (event-sourcing, obligation-lifecycle, supervisor-actions, participant-runtime tests are the regression net).
- [ ] For P1/quick-wins #1–#2: confirm extracted utilities are imported (not re-typed) and that `eventHash`/`traceId`/`reportId` outputs are byte-identical (golden-hash test).
- [ ] For any `workflow/index.ts` decomposition: preserve event APPEND ORDER and hash-chaining (`prevHash`) exactly — replay verification in `runDeterministicWorkflowReplay` checks `event_hash_mismatch`/`prev_hash_mismatch`.
- [ ] Do NOT change the kernel factory's returned object shape or method signatures (public API consumed across packages — see `index.ts` re-exports).
- [ ] P3/P4 (handler table, lifecycle dedup) are behavior-affecting; gate each behind a green test run and review event payloads emitted per branch.
- [ ] Quick-win #4 (obligation resume reuse) requires proving the inlined logic equals `nextTaskAfterObligationClosed` first — otherwise it changes waiting→active resume behavior.
