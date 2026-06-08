# PBC Harness — Implementation Plan (for daedalus review)

Source spec: `PBC_HARNESS_VALIDATION_AND_SPEC.md` (validated against `/mnt/data` snapshots).
This plan is re-grounded against the **live** repos (`~/praesidium/agent-control-plane`, `~/praesidium/wrkq`) as of 2026-06-07.

## Key finding: the spec was written against an older ACP snapshot

~40% of the spec's "to build" is already present in live ACP. Verified:

| Spec claim (§2.4 / §3.9) | Live reality | Impact |
|---|---|---|
| ACP has no `@wrkf/client` dep | `@wrkf/client@0.1.0` present (`packages/acp-server/package.json:29`) | already done |
| No `src/wrkf/*` modules | `port.ts`, `client-lifecycle.ts`, `errors.ts`, `participant-launch.ts` exist | infra done |
| Participant route uses ACP durable kernel | Already wrkf-backed via `launchParticipant` (`handlers/workflow-participant-runs.ts`, `source:'wrkf'`) | correction #9 **moot** |
| No wrkf effect delivery | `integration/wrkf-effect-reconciler.ts` does claim/ack/fail w/ lease semantics | pattern exists |

Everything else in the spec checks out exactly against live wrkq: protocol `2026-06-01`, all 13 error classes (already mapped in `errors.ts`), `pbc-progressive-refinement@5`, 13 transitions, 8 states, 9 evidence kinds, 2 obligations, `set_task_state`-only effects, SoD on both finalize transitions, required facts. The smoke test (`wrkq/test/smoke-wrkf-rpc.sh:415-469`) is the integration-test blueprint.

## Real delta to build (PBC orchestration on top of existing generic wrkf port)

The existing `src/wrkf/` is a *generic single-step participant launcher* (used by agent-tasker): run.start → launch HRC → bindExternal, with crash-safe claims. It has NO PBC-specific behavior:

1. **Strong typing** — `port.ts` returns `unknown`/`Record<string,unknown>`. No typed `NextActionResponse`/`Instance`/`Effect`.
2. **Prompt compiler** — no reading of `nextActionModel` from `workflow.show`; current prompt is a generic JSON dump (`participant-launch.ts:366`).
3. **Evidence ingestion + obligation satisfaction loop** — nothing ingests `ParticipantOutput`, adds evidence w/ actor/role/data, re-lists obligations, satisfies, re-reads `next`.
4. **Transition application with fresh CAS** — no harness-side `transition.apply` (only `run.finish`/`fail` wired).
5. **`set_task_state` effect delivery** — reconciler's `SUPPORTED_EFFECT_KINDS = ['wake_role','request_observer_review']` does NOT include `set_task_state`, PBC's only effect.
6. **Autopilot** (`run-until-blocked`) with PBC state-policy table §4.13 + SoD stop + disposition gating.
7. **PBC routes** — none of `/v1/wrkf/pbc/*` exist.

## Phases

### Phase 0 — verify two open questions (no code)
- **`set_task_state` delivery mechanism**: does the running `wrkf` binary have a *server-side* adapter that applies `set_task_state` to the wrkq task on `effect.deliver({adapter})`, or must ACP claim+apply via wrkq-lib (like `wake_role`)? Grep `wrkq/internal` for a `set_task_state` handler. Decides whether Phase 4 is `wrkf.effect.deliver` one-liner or a new reconciler arm.
- **Evidence passthrough**: confirm `@wrkf/client`'s `evidence.add` forwards extra keys (`actor`,`role`,`data`) to RPC despite its TS `EvidenceAddParams` omitting them. ACP `port.ts` already types it `Record<string,unknown>`, so this is confirming the client spreads, not whitelists.

### Phase 1 — typed projections + template model (`projections.ts`, `pbc-template-model.ts`)
Narrow loose port returns into typed `NextActionResponse` (instance.revision/contextHash/state.status+phase, actions, blockedTransitions, openObligations, pendingEffects) and parse `workflow.show().nextActionModel`. Pure functions, fully unit-testable. Extract shared `isRecord`/`readOptional*` helpers from `participant-launch.ts`.

### Phase 2 — prompt compiler (`pbc-prompt-compiler.ts`)
Spec §4.8: select phase guidance by `instance.state`, role hard rules, candidate/blocked transition guidance, open obligations + required evidence kinds, the `ParticipantOutput` schema, guardrails. Driven entirely by template `nextActionModel` — no hard-coded phase text.

### Phase 3 — evidence + obligations (`pbc-evidence.ts`)
Spec §4.9–4.10: validate facts vs template (best-effort), `evidence.add` w/ actor/role/data → `obligation.list` → match by id/kind → `obligation.satisfy` → **re-read `next`** (context-hash rotation invariant). Block agent-role product-owner fabrication unless `allowProductOwnerSimulation`.

### Phase 4 — `set_task_state` effect delivery (extend `wrkf-effect-reconciler.ts` or new `effect-delivery.ts`)
Per Phase-0 finding: add `set_task_state` to delivery, or wrap `wrkf.effect.deliver({effectId, adapter:'acp'})`. Preserve lease-token semantics; `WRKF_LEASE_CONFLICT` non-fatal (already → 409).

### Phase 5 — harness orchestrator (`pbc-harness.ts`)
Three ops returning normalized `PbcHarnessResult` (spec §4.7):
- `runStep` — one participant action; transition only if `transitionPolicy` asks.
- `approveTransition` — re-read `next`, apply w/ fresh `expectRevision`+`contextHash`, deterministic idempotency key.
- `runUntilBlocked` — autopilot per §4.17 + state-policy table §4.13: SoD stop (`requires_distinct_pressure_reviewer`), product-owner obligation stops, disposition gating, stale/context single-retry.
Reuse `launchParticipant` for run lifecycle, don't reimplement.

### Phase 6 — routes (`handlers/wrkf-pbc-*.ts` + `routing/param-routes.ts`)
5 routes from §4.6 as `createParamRoute(...)` entries (existing custom Web-API router). Mutating routes get `withActorAndAuthz` + body-hash idempotency. Translate route `:task` → wrkf `task`; map errors via existing `wrkfErrorToHttpStatus`.

### Phase 7 — tests
- Unit (fake `WrkfPort`): the §4.18 conformance list (wire names, `next` w/o actor, revision from `next.instance`, re-read after evidence, `run.finish` never gets `evidenceRefs`/`outcome`/idempotencyKey, obligation-before-transition, SoD stop, `set_task_state` delivery, disposition gating). Follow `makeFakeWrkfPort` + `_calls` spy pattern from `wrkf-participant-launch.test.ts`.
- Integration (real `wrkf rpc --stdio`): mirror smoke path — install/attach `@5`, ready path `normalize_feedback → draft_pbc → run_pressure_pass → finalize_ready_pbc`, distinct pressure actor, closed/finalized + no next actions + `set_task_state` delivered. Plus clarification, patch-finalize, patch-revise, too_vague, disposition, stale-revision, idempotency-replay paths.

### Phase 8 — real e2e via **ghoste2e**
Drive a live Ghostty terminal (ghoste2e skill) against the installed binary: `just install`, `acp server restart`, attach a real wrkq task to `pbc-progressive-refinement@5`, drive `run-until-blocked` through the running ACP server, confirm the wrkq task lands `completed` via the delivered `set_task_state` effect — observed in a real terminal + the hrc event stream. Not `bun test`.

## Decisions baked in (flag if wrong)
- **New `/v1/wrkf/pbc/*` routes** rather than overloading the generic participant-run route (spec recommends; autopilot/prompt-compile is new surface).
- **Reuse `launchParticipant`** for run lifecycle instead of the spec's from-scratch `participant-launch.ts` (spec assumed it didn't exist).

## daedalus review (LOCKED 2026-06-08) — applied changes

Verdict: **approve-with-changes**. These supersede the phase text above where they conflict.

**Phase-0 RESOLVED (no dispatched task needed):**
- Native `set_task_state` delivery EXISTS in wrkq: `internal/workflow/ledger.go:1133-1134` → `deliverSetTaskStateEffect` (`:1218`) claims by id, validates target state, updates wrkq task state, acks with receipt. `wrkf.effect.deliver` registered at `internal/wrkfrpc/api_registry.go:191`.
- `EffectDeliverParams` = `{ effectId, adapter }` only (`internal/wrkfapi/types.go:105`). TS client's `task?` on `effect.deliver` is **ignored by server** — a task-scoped ACP route MUST `effect.list({task})` then `effect.deliver({effectId})` per pending effect.
- Evidence `actor`/`role`/`data` pass through at runtime.

**Change 1 — `launchParticipant` is a launch/bind adapter ONLY, not the PBC run-lifecycle.**
PBC owns its own run-step state machine. Two modes:
- supplied/offline `participantOutput`: harness calls `run.start → evidence.add/obligation.satisfy → run.finish` directly.
- `launchRuntime: true`: harness compiles prompt → `launchParticipant({ initialPrompt })` → returns `launched/replay`; **do NOT auto-transition until participant output is captured and ingested.**
Keep PBC policy (phases, SoD, disposition, obligations) OUT of the generic participant route/launcher.

**Change 2 — NEW Phase 4.5 (before Phase 5): structured participant-output capture contract.**
This is the biggest risk. The existing launcher has no return channel for structured `ParticipantOutput` from a launched HRC run. Define the capture/ingestion contract (idempotent), OR make the first implementation manual/offline-output only. Autopilot may operate only on supplied `participantOutput` or a deterministic test participant until this lands.

**Change 3 — Phase 4 is NATIVE delivery, not reconciler extension.**
Do NOT add `set_task_state` to `wrkf-effect-reconciler`'s `SUPPORTED_EFFECT_KINDS` (that reconciler stays a coordination adapter for `wake_role`/`request_observer_review`). Add `wrkf/effect-delivery.ts`: `effect.list({task})` → `effect.deliver({effectId, adapter:'acp'})` per pending effect.

**Change 4 — Phase 6 idempotency is a hard dependency.**
`evidence.add` has NO wrkf idempotency key, so wrkf will not dedupe duplicate evidence. PBC mutating routes MUST persist request-body hash / idempotency BEFORE exposure. Routes MUST be added to `mutatingRouteSpecs`/authz wrapping, not only `param-routes`.

**Change 5 — Phase 7 must add these explicit tests:**
task-scoped delivery does `list → deliver(effectId)` and NEVER manual-claims `set_task_state`; repeated `run-step` with same route idempotency key does NOT duplicate evidence; runtime-launch mode does NOT transition before output ingested; `run.finish` happens only after evidence/obligation processing succeeds.

**Change 6 — Phase 2+3 single owner** (close coupling). Do not split across two impl agents.

**Change 7 — wrkq follow-up task** (not a blocker): fix `@wrkf/client` types — widen `EvidenceAddParams` (`data`/`actor`/`role`), remove misleading `task?` from `effect.deliver`, tighten `NextActionResponse`/effect shapes.

## Original questions for daedalus (answered above)
1. Is reusing `launchParticipant` (generic launcher) inside the PBC harness the right seam, or should PBC get its own run-lifecycle path to keep agent-tasker and PBC decoupled?
2. `set_task_state` delivery: prefer extending the existing `wrkf-effect-reconciler` (one adapter, all effect kinds) vs a separate `effect-delivery.ts` for PBC? Concern: reconciler currently does manual claim/ack/wake; PBC may just want `wrkf.effect.deliver`.
3. Phase parallelism: Phases 1→2→3→5 are a dependency chain; 4 and 6 partly independent. Is the proposed sequencing right for a shared worktree (default sequential impl)?
4. Any risk in the loose-typing→typed-projection boundary that would argue for upstreaming stronger types into `@wrkf/client` instead of re-projecting in ACP?
