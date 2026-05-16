# acp-core: Workflow Event Store Extraction

Refactor proposal — first arc toward decomposing `packages/acp-core/src/workflow/index.ts` (3456 lines).

Peer-reviewed with cody. Scope and sequencing reflect cody's guardrails.

## Survey findings

Ranked by impact:

1. **`workflow/index.ts` is one 3456-line closure factory** (`createInMemoryWorkflowKernel`) holding 10+ handler functions, the event-sourcing core, canonicalization utilities, and two large context-builder functions. Natural split lines are visible in existing test file names (`workflow-obligation-lifecycle`, `workflow-supervisor-actions`, `workflow-event-sourcing`, `workflow-participant-runtime`).
2. **Canonicalization utilities are duplicated** — `stableJson`/`sortJson`/`hashValue`/`clone`/`deepFreeze` appear in `workflow/index.ts`, `learning/index.ts`, and a local `reject()` helper repeats in `validators/transition-policy.ts`.
3. **Event-sourcing logic is smeared across every handler** — `appendEvent` is called from 30+ sites in workflow/index.ts; `commandHash`/`eventHash`/`prevHash`/`workflowSeq` rules are owned inside the closure with no module boundary.
4. **Context builders** (`compileParticipantContext` + `compileSupervisorContext`, ~340 lines combined) are repetitive affordance assembly inside the closure; a separate `task-context.ts` has overlapping intent.
5. **Validators vs. kernel** — `validators/transition-policy.ts` and the in-kernel state checks both decide "is this state legal," but they operate on different task/workflow models.

## Decision: event-store extraction first

Per cody's review, frame this as drawing an explicit **event store + canonical hash** boundary — not just moving helpers.

Defer:
- Splitting handlers along test seams (closure couples maps, sequence allocation, frozen `now`, idempotency, context hashes, event append, snapshot export — splitting handlers before naming that shared state contract creates a giant context bag and churn).
- Unifying validators with kernel checks (different models, semantic drift risk).
- Touching context builders (next arc, after event-store boundary is in).

## Workflow events vs. HRC events

This is the boundary the refactor makes enforceable.

**Today (implicit):**
- `workflow/index.ts` defines `WorkflowEvent` (hash-chained, `eventHash`/`prevHash`/`workflowSeq`, `commandHash`) — the **kernel's source-of-truth events**. `appendEvent` only ever writes these.
- `WorkflowHrcRunMap` (`workflow/index.ts:264`) is the join table to HRC's world — carries `hrcRunId`/`runtimeId`/`launchId`/`hostSessionId`. HRC events themselves are never appended into the workflow chain.
- `learning/index.ts` joins the two streams by `hrcRunId` and aggregates HRC event stats (`hrcEventStats`, `hrcToolCalls`, `hrcToolErrors`) into traces. HRC counts come in as inputs, not as workflow events.

The separation exists conceptually, but it's only enforced by convention. `appendEvent` lives in a 3456-line closure next to a hundred other things; nothing in the type system says "this module is the only place workflow events are minted."

**After the extraction:**
- `workflow/event-store.ts` is the single, explicit owner of workflow source events: canonicalization, `commandHash`/`eventHash`/`prevHash`/`workflowSeq` rules, the append API, the chain verifier.
- HRC events stay extrinsic. They reach acp-core via `WorkflowHrcRunMap` (admission/launch/reconciled mappings) and via the learning-side stats join. They don't go near the event store.
- The type surface forces the distinction: the event-store module imports `WorkflowEvent`/`WorkflowCommand`, not `hrcRunId` semantics. HRC's run-map lookups live elsewhere.

**Out of scope for this arc:**
- Moving `WorkflowHrcRunMap` itself, or the learning-side HRC join. That can become a follow-up `hrc-bridge` submodule once the event-store boundary is in.
- Introducing a new persistence layer or changing semantics. Same events, same hash chain, same join keys — just an enforced module wall.

## Proposed PR

**New file: `packages/acp-core/src/workflow/event-store.ts`**

Owns:
- `stableJson` / `sortJson` / `hashValue` / `clone` / `deepFreeze` (delete duplicates in `learning/index.ts` and `validators/transition-policy.ts`)
- `appendWorkflowEvent(state, command) → { event, prevHash, seq }` — the chain rules for `commandHash` / `eventHash` / `prevHash` / `workflowSeq`
- A chain verifier (replay/test entry point)

**Constraints:**
- Public kernel API unchanged — only internals move.
- Preserve invariants: deterministic IDs/now, cloned snapshots/returns, idempotency fingerprinting, context-hash invalidation, hash-chained events.
- Existing tests (`workflow-event-sourcing.test.ts`, others) pass without modification.
- No persistence-layer changes.

**Estimate:** single ~400-line PR, low risk (closure stays, API stays, tests pin behavior).

## Follow-on sequence (not this PR)

1. Context builders → pure-ish modules over read-only `task`/`evidence`/`obligation`/`run` views.
2. Handler split along test-file seams — only after a typed `KernelState`/`KernelServices` boundary is explicit.
3. Optional `hrc-bridge` submodule for `WorkflowHrcRunMap` + learning join, if the boundary keeps proving load-bearing.
4. Validator unification — last, after the above clarify which model is canonical.
