# Proposal: Hermes-parity for ACP + wrkq/wrkf (RECONCILED)

**Author:** clod (agent-control-plane)
**Reviewer:** daedalus — **APPROVED WITH CONSTRAINTS** (DM #8347, 2026-06-17)
**Status:** reconciled → tracked in wrkq

## Context

Gap analysis of Hermes Agent Kanban (Nous, `~/tools/hermes-agent`) vs our ACP +
wrkq/wrkf + hrc stack. Hermes **fuses** task-tracking and execution into one
SQLite-direct CLI (the board is the scheduler). We **split** across wrkq (task
store), wrkf (workflow engine), hrc (runtime lifecycle), acp (gateway/dispatch).
Four execution-loop disciplines Hermes has are scattered or missing in ours.

This proposal closes four. **Deferred (out of scope):** rate-limit-aware respawn,
per-card wall-clock budget, per-assignee WIP caps, completion hallucination gate.

## Authority invariant (daedalus, binding)

For any task **T** with execution correlation **C**:

1. **HRC** is the only authority for runtime liveness of C.
2. **wrkf** is the only authority for workflow instance state, legal transitions,
   obligations, workflow runs, and effects.
3. **wrkq** is the authority for task/card fields, but **not** for process liveness.
4. **ACP** may reconcile disagreement only by reading HRC liveness + existing
   ACP/wrkf correlation, then applying public wrkf/wrkq RPC mutations with
   CAS/idempotency. It must never infer liveness from wrkq fields and never store
   execution leases/heartbeats in wrkq.
5. `ready` is true only as a **projection**: no future `start_at`, no unresolved
   wrkq blockers for the relevant card view, and (for workflow-attached tasks)
   wrkf `next` exposes ≥1 legal claimable action / no blocking prerequisite for
   the intended actor/role.
6. `blocked_reason` is explanatory metadata **derived** from authoritative
   blockers — not an independent state machine that can diverge from wrkf/HRC facts.

## Process owner boundaries

The correlation chain spans **four distinct processes**. Knowing which one *owns*
vs *invokes* each step is what makes P1/P4 land in the right place.

| Process | Role | Owns / executes |
|---|---|---|
| **acp-server** (long-lived Bun daemon) | **orchestrator** | HTTP API, the run-store `StoredRun` join (its own better-sqlite3), the dispatch fence, and the single shared `@wrkq/client` `WorkClient`. Runs every dispatcher (event-job, flow/job, interface/input, participant-launch). It *invokes* wrkf and HRC; it owns neither. |
| **`wrkf` binary subprocess** (`wrkf rpc` over stdio, **spawned & owned by acp-server**, operating on the wrkq SQLite db) | **workflow authority** | `wrkf.run.start`, `wrkf.run.bindExternal`, `wrkf.transition.apply`, `wrkf.run.fail` all **execute here**. acp-server is only the caller. |
| **hrc-server** (separate daemon, reached via `HrcClient`) | **runtime authority** | `resolveSession` (scope→host session), broker provisioning, `dispatchTurn`/`deliverLiteral`. Owns runtime liveness. |
| **agent runtime** (PTY in tmux, spawned by HRC's broker) | **worker** | Does the role's work; calls **back into acp-server over HTTP** to drive transitions. Never talks to wrkf directly. |

**Who runs `wrkf.run.start`:** the `wrkf` subprocess *executes* it; **acp-server
invokes** it from `launchParticipant` (`participant-launch.ts:71`), inside the
`POST /v1/workflow-participant-runs` handler.

**What triggers that:** an ACP dispatcher *inside acp-server*, fired by one of —
a wrkq task event (global webhook → ACP sink), a scheduled `acp job` (cron), an
interface/input arrival, or a wake/heartbeat. This **dispatch-eligibility
boundary** is exactly where **P4's breaker** sits (gate *before* the launch), and
where **P1's reconciler** lives (read hrc-server liveness via `HrcClient`, then
call `wrkf.run.fail` in the wrkf subprocess + update the `StoredRun`).

```
wrkq event / cron / interface input / wake
  → ACP dispatcher (acp-server)                ← P4 breaker gates here
  → POST /v1/workflow-participant-runs
  → launchParticipant (acp-server)
  → wrkf.run.start  (executes in the wrkf subprocess)
  → launchRoleScopedRun → HrcClient.resolveSession (hrc-server provisions runtime)
  → runStore.updateRun(hrcRunId,hostSessionId,runtimeId,generation)  +  wrkf.run.bindExternal
```

The runtime later "transitions wrkf state" only by calling **back into acp-server**
(`acp task transition` / `run-complete`), which re-invokes the wrkf subprocess —
gated by the dispatch fence (`hostSessionId`+`generation`) that pins the *current*
owning runtime. Nothing today re-reads HRC liveness for a fenced runtime that
died mid-run; that reconciliation is P1.

## Sequencing (daedalus)

**minimal P2 reason/projection contract → P1 → P4 → P3.** Do not start with a broad
status-vocabulary migration. P1 is the operational hazard; P4 before generic P3
because uncontrolled redispatch is the higher blast radius.

---

## P1 — Task-liveness reconciliation (ACP reconciler)

**Problem.** A wrkq card reads `in_progress` while its HRC runtime is already dead;
nothing reconciles task-state with worker-liveness ("running for 40 min while the
worker had already died").

**Design (constrained).**
- ACP-side reconciler. Read HRC liveness through an **HRC-facing port**
  (`HrcClient` / runtime inspect / list / reconcile-active) — never shell out to
  `hrc`/`wrkq`, never open wrkq SQLite.
- **Correlation:** identify the affected task via **ACP runStore + wrkf run
  correlation** (participant-launch creates wrkf run → ACP run → HRC launch/bind;
  run-store holds HRC refs). Do **not** rely on `cp_run_id/session_id/run_status`
  through `@wrkq/client` — the typed `WrkqTask`/`WrkqTaskUpdateParams` do not expose
  those fields (they live in wrkq CLI/storage). Either correlate via ACP/wrkf runs
  (preferred) or extend the wrkq RPC/client contract deliberately.
- On HRC **terminal/dead** evidence, after a **grace window**, with
  **runtime-generation / hostSession** match and **wrkq etag** check: mutate via
  public RPC with CAS/idempotency — fail the ACP run **and** `wrkf.run.fail`, and
  move the task to `open`/`blocked` with a derived reason event.
- **No** heartbeat/PID/lease columns on wrkq.

**Reject:** Hermes-style lease columns on the task row.

---

## P2 — Stuck-reason / projection vocabulary (minimal first)

**Problem.** wrkq's flat states collapse Hermes's `triage / scheduled / ready /
blocked / review`; we can't express *why* a card is stuck.

**Design (constrained).**
- These are **projections, not first-class wrkq states**: `triage`→`draft/idea`,
  `scheduled`→`start_at` in future, `ready`→`open` + no open blockers (+ wrkf
  `next` for workflow-attached), `review`→a wrkf phase.
- Stuck-reason taxonomy is a **projection / metadata / event contract first**, not
  a new top-level wrkq column. Persist only if required, in the narrowest
  authority-owned store: **wrkf** obligation/blocker data (workflow reasons),
  **ACP** coordination/event metadata (execution/breaker/runtime reasons), **wrkq
  `meta`** only for card-level annotations.
- `breaker_tripped` must **not** enter wrkq core state semantics.
- Land only the minimal contract P1/P4 need to report reasons consistently.

---

## P3 — Dependency-clearance promotion (split)

**Problem.** A `blocked` child isn't auto-advanced when its blocker/parent completes.

**Design (constrained — daedalus split).**
- wrkf already expresses **workflow-local** readiness via `next.actions`,
  `blockedTransitions`, and open obligations → **no auto-`ready` state needed there.**
- But wrkf relation handling only blocks **closure** on unresolved `blocks`
  relations; it does **not** generically promote wrkq `blocked` tasks when a
  parent/blocker completes. **Generic wrkq relation/parent clearance needs the ACP
  reconciler** (co-located with P1) — unless wrkf is explicitly extended to own that
  rule. Completing/cancelling blockers clears `needs_dep` and projects ready/open
  without touching unrelated workflow state.

---

## P4 — Circuit breaker / N consecutive failures (shared dispatch boundary)

**Problem.** A failing task can be re-dispatched indefinitely; no auto-give-up.

**Design (constrained).**
- Breaker lives at the **ACP dispatch-eligibility boundary**, **not** inside wrkf
  supervisor. The **same guard must be shared** by: event jobs, flow/job dispatch,
  interface/input dispatch, and workflow-participant launch (where the target is
  task-scoped) — do not bury it only in the event-job path.
- Track **N consecutive failed dispatches** per task (default 3, per-task override).
  On threshold: **block further dispatch**, emit an ACP coordination/system event,
  and surface `breaker_tripped` into the task/workflow projection. **Reset on a
  successful run.**
- wrkf supervisor may deliberate afterward; it is **not** the cheap retry stop.
- If breaker state must be workflow-visible, add a **proper wrkf mechanism** — do
  not smuggle a breaker obligation through task state (no generic
  create-obligation-from-ACP API exists today).

---

## Residual risks (daedalus)

- **High:** `@wrkq/client` does not expose cp linkage fields → correlate via ACP
  runStore / wrkf run, or extend the client contract deliberately.
- **High:** reconciler can race a recovered/reused runtime → require grace windows,
  HRC terminal/dead evidence, generation/hostSession match, wrkq etag checks.
- **High:** failing only the ACP run while wrkf run stays `active` preserves the
  stale-workflow bug → P1 must `wrkf.run.fail` too.
- **Med:** wrkq-only `blocked` can diverge from an active wrkf instance whose `next`
  still offers actions → projection shows both / prefers wrkf for workflow-attached.
- **Med:** persisted reason enum can ossify → start with a small projection
  taxonomy, keep raw blocker/event detail.
- **Med:** P4 in only event-job path misses manual/interface/participant redispatch
  → centralize the policy.
