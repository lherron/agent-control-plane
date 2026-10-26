# ACP proposal: generic wrkf workflow runtime + PBC workflow pack

## Decision

Implement the combined work as **two ACP layers**:

1. A **generic wrkf workflow runtime** in ACP. This runtime owns reusable execution mechanics for wrkf-backed workflows: inspect, run launch, output capture, evidence ingestion, obligation satisfaction, fresh `wrkf.next`, CAS transition application, effect delivery, projections, idempotency, and durable job correlation. It must not contain PBC vocabulary.
2. A **PBC Level 3 workflow pack and PBC product facade**. PBC remains deliberately specific: prompts, artifact schemas, state policy, SoD checks, clarification handling, patch-decision handling, stale-artifact freshness, finalization, and disposition are PBC-specific behavior layered on top of the generic runtime.

The PBC workflow itself should not be generalized. The harness/API should be generalized so ACP can later drive other wrkf workflows without cloning `pbc-harness.ts`.

Target shape:

```text
ACP HTTP product routes:        /v1/pbc/*
  -> PBC product facade:        start / get / input / continue / dispose / jobs
    -> PBC workflow pack:       prompt compiler / parser / transition policy / projection
      -> Generic wrkf runtime:  runs / evidence / obligations / transitions / effects
        -> AcpWrkfWorkflowPort
          -> @wrkf/client / wrkf RPC
```

wrkf remains the authority for workflow templates, instances, legal transitions, evidence, obligations, runs, effects, revisions, context hashes, and idempotent transition application.

---

## Pressure test against the actual implementation

### What is already usable

ACP already has a strong generic wrkf port. `packages/acp-server/src/wrkf/port.ts` exposes workflow install/show/list/diff, task attach/inspect/timeline/refresh/syncMeta, `next`, evidence add/list/show/suggest, obligation list/show/satisfy/waive/cancel, transition apply, run start/bindExternal/finish/fail/list/show, and effect list/show/claim/ack/fail/retry/deliver. The core wrkf capability does not need to be invented.

ACP already has a generic-ish task inspection route at `GET /v1/tasks/:taskId`. It calls `task.inspect`, `task.timeline`, `next`, evidence, obligations, effects, and runs, then returns a `source: 'wrkf'` projection. This should be hardened and possibly aliased under `/v1/wrkf/tasks/:taskId`, not replaced.

ACP already has HRC launch correlation for wrkf participant runs. `packages/acp-server/src/wrkf/participant-launch.ts` starts a wrkf run, creates or reuses an ACP run with `runStore.createOrGetRun`, launches HRC through `launchRoleScopedRun`, and binds the external run through `wrkf.run.bindExternal`. `packages/acp-server/src/jobs/run-final-output.ts` can recover final assistant text from HRC event logs. These are the correct primitives for a product worker.

ACP already has a PBC prompt compiler and template-model parser. `pbc-prompt-compiler.ts` reads `nextActionModel`, emits the PBC participant-output contract, and includes the correct guardrails. `pbc-template-model.ts` parses `pbc-progressive-refinement@5` guidance out of the wrkf template. These should move into the PBC pack, not into generic runtime.

The current PBC harness has valuable invariants that should be preserved: no transition before participant output is ingested, `wrkf.next` is re-read after evidence/obligation writes, `run.finish` happens only after successful ingestion, disposition is never selected by autopilot, finalization respects SoD, and transition application uses fresh revision/context where the harness re-reads next. The refactor should lift those mechanics into generic runtime while keeping PBC policy in the PBC pack.

Effect delivery is less PBC-specific than its name suggests. `deliverPbcEffects` lists pending effects and calls `wrkf.effect.deliver({ effectId, adapter })`; wrkf owns the internal claim/lease/ack/fail path for supported effects such as `set_task_state`. This should first be renamed/extracted to generic `deliverWrkfEffects`; do not over-rotate into a manual ACP adapter registry for `set_task_state` in the first pass.

### Actual gaps and proposal corrections

The current PBC harness is not a product worker. `runStep({ launchRuntime: true })` starts a wrkf run and returns immediately with an “awaiting participant output” diagnostic. It does not launch HRC, does not collect final assistant output, does not parse the PBC participant output, does not ingest evidence, and does not advance transitions.

`runUntilBlocked` is not an agent executor. It only applies legal transitions when required evidence already exists, plus optional product-owner simulation for tests. It does not compile prompts or generate missing PBC evidence. This explains why the current harness cannot execute the PBC workflow’s primary function from a user-facing flow.

The generic evidence route is too weak for PBC and future workflows. `POST /v1/tasks/:taskId/evidence` currently requires `ref` and drops `data`, even though `AcpWrkfWorkflowPort.evidence.add` supports `data`, `actor`, and `role`. PBC artifacts need structured `data`, and many PBC evidence records should not require a `ref`.

The generic transition route is not a safe product surface. `POST /v1/tasks/:taskId/transitions` accepts caller-provided `expectedTaskVersion` / `contextHash`; product routes should not ask browsers to submit wrkf CAS data. Product routes must re-read `wrkf.next` server-side immediately before applying transitions.

There is no generic obligation satisfy HTTP route exposed, even though the port supports `obligation.satisfy`. PBC clarification and patch-decision forms need explicit product-owner obligation satisfaction.

The current PBC route idempotency and participant capture stores are in-memory fallbacks. That is fine for tests and local debugging, but not for product execution. PBC continuation jobs and participant captures need durable state.

The Taskboard-facing PBC facade does not exist. Existing `/v1/wrkf/pbc/*` routes are operator/debug primitives: inspect, run-step, approve-transition, run-until-blocked, and effect reconciliation. The product API must expose PBC verbs: start, get projection, submit input, continue, dispose, and job status.

The wrkf PBC template v5 lacks explicit iteration/freshness guards. Transitions require evidence by kind and facts, so after a revise path, stale `pbc_draft`, stale `pressure_pass`, or stale `pbc_final` evidence may remain satisfiable unless the pack enforces freshness. This is the highest-risk correctness issue in the proposal.

The TypeScript wrkf client types appear behind the actual RPC/ACP port for evidence `data` and actor/role fields. If the ACP code imports those stale client types directly, update `packages/wrkf-client/src/types.ts` or isolate the wider ACP port types.

---

## Architecture boundaries

### wrkf owns canonical workflow truth

ACP must not persist a parallel canonical workflow state. wrkf owns:

```text
workflow templates
workflow instances
workflow revisions and context hashes
legal transitions and blockers
evidence records
obligations
runs and external run bindings
effects, effect leases, and effect receipts
transition idempotency and stale-revision checks
workflow event ledger
```

### Generic ACP runtime owns execution mechanics

The generic runtime owns reusable wrkf execution convenience:

```text
workflow projection shaping
pack resolution
route idempotency wrappers
participant run orchestration
HRC launch and external binding
generic participant-output capture replay
generic evidence write path
generic obligation satisfaction path
fresh wrkf.next reads before transitions
CAS transition application
generic effect delivery via wrkf.effect.deliver
manual/debug workflow operations
```

It may ask a workflow pack which transition is safe. It must never invent legal transitions or mutate workflow state outside wrkf.

### Workflow packs own semantics

A workflow pack owns workflow-specific behavior:

```text
workflow ref/version/template-hash support checks
prompt compilation
participant output parsing and validation
artifact schemas
human input mapping
obligation satisfaction policy
transition selection policy
actor/lane defaults
SoD interpretation
projection enrichments
workflow-specific stop reasons
workflow-specific freshness guards
```

PBC is a Level 3 code pack.

---

## ACP module changes

### New generic runtime layout

Add a generic runtime directory and move PBC-specific code behind a pack boundary:

```text
packages/acp-server/src/wrkf/runtime/
  workflow-pack.ts
  workflow-pack-registry.ts
  workflow-projection.ts
  workflow-harness-core.ts
  evidence-writer.ts
  participant-capture.ts
  participant-runner.ts
  effect-delivery.ts
  transition-apply.ts
  route-idempotency.ts
  value.ts                         # reuse current value helpers where possible

packages/acp-server/src/wrkf/packs/pbc/
  manifest.ts
  template-model.ts                # moved from pbc-template-model.ts
  prompt-compiler.ts               # moved from pbc-prompt-compiler.ts
  output-parser.ts
  evidence-policy.ts               # PBC facts, gates, and artifact data validation
  transition-policy.ts
  freshness.ts
  projection.ts
  worker-policy.ts

packages/acp-server/src/pbc/
  routes.ts
  projection.ts
  start.ts
  input.ts
  continue.ts
  dispose.ts
  jobs.ts
  worker.ts
```

After extraction, these strings should not appear in `src/wrkf/runtime/**`:

```text
pbc
pressure
patch_decision
clarification_response
finalize_ready_pbc
revise_too_vague_pbc
dispose_from_
pbc-progressive-refinement
```

The old `pbc-harness.ts` should become either a compatibility wrapper over the new pack/runtime or be deleted after route migration. Its tests should be split into generic runtime tests and PBC pack tests.

---

## Generic workflow pack contract

Keep pack methods pure where possible. The generic runtime performs wrkf mutations; packs choose and validate.

```ts
export type WorkflowPackLevel = 0 | 1 | 2 | 3;

export type WorkflowPackSupport = {
  supported: boolean;
  level: WorkflowPackLevel;
  reason?: string;
};

export type WorkflowPack = {
  id: string;
  displayName: string;

  supports(input: {
    workflowRef: string;
    workflowId?: string;
    version?: string;
    templateHash?: string;
    template?: unknown;
  }): WorkflowPackSupport;

  compilePrompt?(input: WorkflowPromptInput): Promise<CompiledPrompt>;

  parseParticipantOutput?(input: {
    taskId: string;
    role: string;
    actor: unknown;
    finalAssistantText: string;
    projection: WorkflowTaskProjection;
  }): Promise<WorkflowParticipantOutput>;

  mapHumanInput?(input: {
    taskId: string;
    actor: unknown;
    inputKind: string;
    body: unknown;
    projection: WorkflowTaskProjection;
  }): Promise<WorkflowParticipantOutput>;

  chooseTransition?(input: {
    projection: WorkflowTaskProjection;
    output?: WorkflowParticipantOutput;
    mode: 'agent' | 'human-input' | 'operator';
  }): Promise<WorkflowTransitionChoice>;

  project?(projection: WorkflowTaskProjection): Promise<unknown>;

  workerPolicy?: WorkflowPackWorkerPolicy;
};
```

Support levels:

```text
Level 0 — unsupported:
  Inspect only. Manual evidence and manual transition routes can still work.

Level 1 — template-only:
  Generic prompt from wrkf template/next metadata. Manual or conservative transition approval.

Level 2 — declarative pack:
  Declarative roles, artifact schemas, safe transitions, and human gates.

Level 3 — code pack:
  Custom prompt compiler, parser, transition policy, product projection, and worker policy.
```

PBC starts as Level 3. Add one non-PBC wrkf fixture later to prove the runtime is not PBC-shaped.

---

## Generic projection

Upgrade the current `GET /v1/tasks/:taskId` projection rather than replacing it. A generic projection should expose enough data for debug/manual operation and enough structure for product facades to project from it.

```ts
export type WorkflowTaskProjection = {
  source: 'wrkf';
  task: {
    id: string;
    title?: string;
    state?: string;
    projectId?: string;
    containerId?: string;
    raw?: unknown;
  };
  workflow?: {
    ref: string;
    id?: string;
    version?: string;
    templateHash?: string;
  };
  pack: {
    id?: string;
    level: 0 | 1 | 2 | 3;
    supported: boolean;
    reason?: string;
  };
  instance?: {
    id: string;
    status: string;
    phase: string;
    revision: number;
    contextHash?: string;
    stale?: boolean;
  };
  next: {
    actions: unknown[];
    legalTransitions: WorkflowTransitionProjection[];
    blockers: unknown[];
    blockedTransitions: unknown[];
  };
  evidence: WorkflowEvidenceProjection[];
  obligations: WorkflowObligationProjection[];
  effects: WorkflowEffectProjection[];
  runs: WorkflowRunProjection[];
  timeline?: unknown[];
  diagnostics: {
    warnings: string[];
  };
};

export type WorkflowEvidenceProjection = {
  id: string;
  kind: string;
  ref?: string;
  summary?: string;
  facts?: Record<string, unknown>;
  data?: unknown;
  actor?: unknown;
  role?: string;
  createdAt?: string;
  raw?: unknown;
};
```

Important actual fix: project `evidence.data` explicitly. Today `projectEvidenceRecord` does not expose `data` except through `raw`, which is not good enough for PBC UI.

---

## Generic route changes

Prefer incremental hardening over a complete route rename. Keep existing `/v1/tasks/:taskId` routes and add `/v1/wrkf/tasks/:taskId` aliases if a clearer namespace is useful.

### Harden existing routes

#### `POST /v1/tasks/:taskId/evidence`

Current actual behavior requires `ref` and drops `data`. Change it to:

```ts
wrkf.evidence.add({
  task: taskId,
  kind,
  ref,        // optional
  summary,
  facts,
  data,       // forward exactly
  actor,
  role,
});
```

Validation:

```text
kind is required
ref is optional
summary is optional
facts is optional object
data is optional unknown
actor comes from auth/middleware when present, not from untrusted browser body for product routes
```

#### `POST /v1/tasks/:taskId/obligations/:obligationId/satisfy`

Add a generic satisfy route because the port already supports it.

```ts
wrkf.obligation.satisfy({
  task: taskId,
  id: obligationId,
  evidenceId,
  actor,
  role,
  reason,
});
```

Do not pre-check obligation existence in ACP. Let wrkf return canonical errors, matching the existing waive/cancel pattern.

#### `POST /v1/tasks/:taskId/transitions`

Keep this route as an operator/debug primitive, but do not use it for PBC product actions. It accepts caller-provided CAS fields today; product facades should instead use a server-side helper:

```text
read wrkf.next
select expected transition from current legal transitions
apply with current revision/contextHash
retry once on stale revision/context mismatch
re-read wrkf.next after success
```

### Add product-safe generic helpers, not necessarily public routes

```text
applyFreshTransition(task, transition, role, actor, routeKey)
deliverWrkfEffects(task, adapter='acp-pbc')
ingestParticipantOutput(task, role, actor, output, captureKey, packPolicy)
launchWrkfParticipantAndCollectOutput(...)
```

These helpers should be called by `/v1/pbc/*` and future workflow products.

---

## Generic workflow run algorithm

The generic runtime should support a single step and a loop. PBC product execution should use the loop through a durable job worker.

```text
1. Inspect the task and instance through wrkf.task.inspect.
2. Read wrkf.next, evidence, obligations, effects, runs, and timeline.
3. Resolve workflow pack by workflow ref/version/template hash.
4. If no pack supports automation, return inspect/manual projection.
5. If a human gate is active, stop and return projection.
6. Ask the pack whether participant work is needed.
7. Ask the pack to compile the prompt.
8. Start wrkf run idempotently.
9. Launch HRC and bind external run idempotently.
10. Wait for or recover final assistant output outside the browser request.
11. Ask the pack to parse and validate participant output.
12. Write evidence through the generic evidence writer.
13. Satisfy obligations only when explicit input or pack policy authorizes it.
14. Re-read wrkf.next after evidence/obligation writes.
15. Ask the pack to choose one legal transition from current wrkf.next.
16. If ambiguous, blocked, stale, unsafe, terminal, or human-gated, stop.
17. Apply transition through wrkf.transition.apply with fresh revision/contextHash.
18. Deliver pending effects through wrkf.effect.deliver.
19. Re-read projection and continue until stopped or max turns reached.
```

The generic runtime must filter `wrkf.next.actions` to actual transition actions before trying to apply anything. PBC tests already rely on not confusing evidence-collection actions with transitions.

---

## Participant launch and output collection

Do not route PBC worker execution through the public `POST /v1/workflow-participant-runs` HTTP route. Reuse the module-level primitives and extend them where needed.

Current actuals:

```text
participant-launch.ts:
  - starts wrkf run
  - creates/reuses ACP run
  - launches HRC
  - binds external run
  - uses waitForCompletion: false

run-final-output.ts:
  - recovers final assistant text from HRC event logs using runStore + hrcDbPath
```

Preferred implementation:

```text
1. Extract or extend launchParticipant with an internal option:
   waitForCompletion?: boolean
   onEvent?: callback

2. For PBC worker calls, set waitForCompletion=true when the selected launcher supports it.

3. As a replay/crash path, use getRunFinalAssistantText(deps, acpRunId) to recover final text from the persisted HRC event log.
```

Acceptable first implementation:

```text
1. Call launchParticipant as-is.
2. Poll/recover final assistant text with getRunFinalAssistantText.
3. Fail the wrkf run if no final text appears before the worker timeout.
```

The product worker must then parse final text, ingest evidence, finish/fail the wrkf run, and transition. The existing `/v1/workflow-participant-runs/:runId/complete` endpoint only finishes the wrkf run; it does not ingest evidence, so it is not sufficient for PBC.

---

## Generic evidence and capture

Split the current PBC-specific participant-output path into generic mechanics plus PBC policy.

### Generic mechanics

```text
capture key replay before writes
body-hash conflict detection
wrkf.evidence.add for each evidence item
wrkf.obligation.satisfy by explicit obligation id
optional obligation lookup by kind only when pack policy permits
wrkf.next re-read after all writes
result includes evidence IDs, obligation IDs, and fresh next
```

### Pack policy

```text
validate evidence kind and facts
validate data shape
reject evidence kinds this actor/role may not submit
map human forms to participant output
control whether obligations may be satisfied by kind lookup
```

For PBC, the existing validations from `pbc-evidence.ts` should move into the PBC pack:

```text
pre_interview_analysis.facts.clarification_needed: boolean
pressure_pass.facts.verdict: ready | needs_patch | too_vague
patch_decision.facts.route: finalize | revise
disposition_decision.facts.resolution: wont_fix | duplicate | unclear | out_of_scope
agent cannot synthesize clarification_response or patch_decision
```

---

## Effect delivery

Rename `deliverPbcEffects` to `deliverWrkfEffects` and keep the current actual behavior for the first implementation:

```text
list effects for task
filter status === pending
call wrkf.effect.deliver({ effectId, adapter })
treat WRKF_LEASE_CONFLICT as skipped
return delivered/skipped/failed records
```

This matches wrkf RPC semantics where `effect.deliver` owns the supported-effect claim/lease/deliver/ack/fail lifecycle. In particular, do not replace `set_task_state` delivery with an ACP-side manual claim/ack loop unless wrkf changes the contract.

Keep `integration/wrkf-effect-reconciler.ts` for ACP-local coordination effects such as `wake_role` and `request_observer_review`.

---

## PBC workflow pack

### Supported workflow

PBC pack support:

```text
workflow ref: pbc-progressive-refinement@5
template id: pbc-progressive-refinement
template version: 5
support level: 3
```

Pin by template hash when available. If the hash changes and the pack has not been updated, degrade to manual/blocked mode rather than silently running stale prompt/transition policy.

### Actual PBC v5 transition model

The pack should encode policy around the actual v5 transitions:

```text
normalize_feedback:
  open/intake -> active/behavior_note
  requires intake_metadata

ask_clarification:
  active/behavior_note -> waiting/clarification
  requires behavior_note + pre_interview_analysis.clarification_needed=true
  creates clarification_response obligation

draft_pbc:
  active/behavior_note -> active/pbc_draft
  requires behavior_note + pre_interview_analysis.clarification_needed=false

answer_clarification:
  waiting/clarification -> active/pbc_draft
  requires clarification_response evidence + satisfied obligation

run_pressure_pass:
  active/pbc_draft -> active/pressure
  requires pbc_draft

finalize_ready_pbc:
  active/pressure -> closed/finalized
  requires pressure_pass.verdict=ready + pbc_final
  requires SoD between pbc_draft actor and pressure_pass actor

request_patch_decision:
  active/pressure -> waiting/patch_decision
  requires pressure_pass.verdict=needs_patch
  creates patch_decision obligation

revise_too_vague_pbc:
  active/pressure -> active/pbc_draft
  requires pressure_pass.verdict=too_vague

finalize_after_patch_decision:
  waiting/patch_decision -> closed/finalized
  requires patch_decision.route=finalize + satisfied obligation + pbc_final
  requires SoD between pbc_draft actor and pressure_pass actor

revise_after_patch_decision:
  waiting/patch_decision -> active/pbc_draft
  requires patch_decision.route=revise + satisfied obligation

dispose_from_behavior_note / dispose_from_pbc_draft / dispose_from_pressure:
  active/* -> closed/disposed
  requires disposition_decision
  explicit human action only
```

### PBC worker policy

```text
open/intake:
  If intake_metadata exists and normalize_feedback is legal, apply normalize_feedback.

active/behavior_note:
  Launch agent to produce behavior_note and pre_interview_analysis.
  If clarification_needed=true, apply ask_clarification and stop.
  If clarification_needed=false, apply draft_pbc.

waiting/clarification:
  Stop. Human product-owner input required.

active/pbc_draft:
  Launch agent to produce fresh pbc_draft for the current iteration.
  Apply run_pressure_pass when legal.

active/pressure:
  Launch pressure actor distinct from latest draft actor.
  Produce pressure_pass.
  If verdict=ready, also produce pbc_final and apply finalize_ready_pbc.
  If verdict=needs_patch, apply request_patch_decision and stop.
  If verdict=too_vague, apply revise_too_vague_pbc and loop to active/pbc_draft.

waiting/patch_decision:
  Stop. Human product-owner input required.

closed/finalized or closed/disposed:
  Stop.
```

Do not let generic runtime know about “draft actor”, “pressure reviewer”, “clarification”, or “patch decision”. Those are PBC pack concepts.

### PBC output parser

The worker should require strict structured output. Recommended parser behavior:

```text
accept one JSON object, optionally inside a single fenced code block
reject multiple JSON objects
reject prose-only output
validate ParticipantOutput shape
validate evidence kinds/facts/data through PBC policy
reject product-owner evidence from agent role
ignore proposedTransition except as a diagnostic/hint
```

The transition to apply must come from fresh `wrkf.next` plus PBC transition policy, not from the model’s `proposedTransition` alone.

### PBC artifact data

Use structured evidence `data` as the UI source of truth. Summaries remain human-readable fallbacks.

```ts
type IntakeMetadataData = {
  rawFeedback: string;
  source?: string;
  context?: string;
  priority?: string;
  labels?: string[];
};

type BehaviorNoteData = {
  content: string;
};

type PreInterviewAnalysisData = {
  clarificationNeeded: boolean;
  openQuestion?: string;
  defaultAnswer?: string;
  uncertainties?: string[];
  recommendation?: string;
};

type ClarificationResponseData = {
  answer: string;
  acceptedDefault?: boolean;
};

type PbcDraftData = {
  content: string;
  iteration: number;
  basedOnEvidenceIds?: string[];
};

type PressurePassData = {
  verdict: 'ready' | 'needs_patch' | 'too_vague';
  reviewedDraftEvidenceId: string;
  tightenList?: string[];
  patch?: string;
  finalCandidate?: string;
  rationale?: string;
};

type PatchDecisionData = {
  route: 'finalize' | 'revise';
  note?: string;
  acceptedPatch?: boolean;
};

type PbcFinalData = {
  content: string;
  basedOnDraftEvidenceId: string;
  basedOnPressurePassEvidenceId: string;
  basedOnPatchDecisionEvidenceId?: string;
};

type DispositionDecisionData = {
  resolution: 'wont_fix' | 'duplicate' | 'unclear' | 'out_of_scope';
  reason: string;
};
```

### Critical freshness guard

PBC v5 does not encode artifact iteration/freshness strongly enough in wrkf transition requirements. The pack must add a runtime guard before applying `run_pressure_pass`, `finalize_ready_pbc`, or `finalize_after_patch_decision`.

Immediate pack-level invariant:

```text
1. Track the latest revision boundary caused by revise_too_vague_pbc or revise_after_patch_decision.
2. Latest pbc_draft eligible for run_pressure_pass must be created after that boundary.
3. pressure_pass.data.reviewedDraftEvidenceId must equal the current eligible pbc_draft evidence id.
4. pbc_final.data.basedOnDraftEvidenceId must equal the current eligible pbc_draft evidence id.
5. pbc_final.data.basedOnPressurePassEvidenceId must equal the current eligible pressure_pass evidence id.
6. After patch revise, old patch_decision.route=finalize evidence cannot finalize a later draft.
```

Later template v6 improvement:

```text
Add iteration facts and evidence-reference requirements to the wrkf template itself:
  pbc_draft.facts.iteration
  pressure_pass.facts.reviewed_draft_evidence_id
  pbc_final.facts.based_on_pressure_pass_evidence_id
  patch_decision.facts.applies_to_pressure_pass_evidence_id
```

Ship the pack-level guard first; it avoids a wrkf template migration dependency.

---

## ACP PBC product facade

Add product routes separate from the existing operator/debug wrkf routes.

```text
POST /v1/pbc/tasks/:taskId/start
GET  /v1/pbc/tasks/:taskId
POST /v1/pbc/tasks/:taskId/input
POST /v1/pbc/tasks/:taskId/continue
POST /v1/pbc/tasks/:taskId/dispose
GET  /v1/pbc/jobs/:jobId
POST /v1/pbc/tasks/:taskId/effects/reconcile    # operator/debug only
```

These routes call the generic runtime with `requiredPack: 'pbc'` and `requiredWorkflowRef: 'pbc-progressive-refinement@5'`. They should not expose raw transition IDs, `ParticipantOutput`, context hashes, obligation wire shapes, or effect delivery internals to Taskboard.

### `POST /v1/pbc/tasks/:taskId/start`

Request:

```ts
type PbcStartRequest = {
  idempotencyKey: string;
  intake: IntakeMetadataData;
  actor?: unknown;       // from auth/middleware preferred
  autoContinue?: boolean;
};
```

Algorithm:

```text
1. Check durable route idempotency by route + taskId + actor + idempotencyKey + body hash.
2. Ensure pbc-progressive-refinement@5 is installed.
   - Use configured template path or require preinstall in deployment config.
3. Inspect task workflow attachments.
4. If an active PBC instance already exists, reuse it.
5. If an active non-PBC workflow instance exists, return conflict.
6. If a closed PBC instance exists, return conflict unless restart semantics are explicitly added.
7. If no PBC instance exists, call wrkf.task.attach.
   - Do not assume task.attach is idempotent; guard with inspect before attach.
8. Add intake_metadata evidence idempotently.
9. Re-read wrkf.next.
10. Apply normalize_feedback only if it is exactly legal.
11. Deliver effects.
12. Admit/replay a PBC continuation job unless waiting/terminal.
13. Return PBC projection plus job metadata.
```

### `GET /v1/pbc/tasks/:taskId`

Returns the PBC product projection. It should be safe for Taskboard to render directly.

### `POST /v1/pbc/tasks/:taskId/input`

Request:

```ts
type PbcInputRequest = {
  idempotencyKey: string;
  kind: 'clarification_response' | 'patch_decision';
  data: ClarificationResponseData | PatchDecisionData;
};
```

Algorithm:

```text
1. Authenticate human actor.
2. Re-read PBC projection.
3. Reject if the current screen does not accept the submitted input kind.
4. Map form input through PBC pack into evidence.
5. Add evidence through generic evidence writer.
6. Satisfy the matching open obligation explicitly.
7. Re-read wrkf.next.
8. Apply the expected transition:
   - answer_clarification
   - finalize_after_patch_decision
   - revise_after_patch_decision
9. Deliver effects.
10. Admit/replay continuation if active.
11. Return fresh projection and job metadata.
```

For `patch_decision.route='finalize'`, require or derive `pbc_final` evidence before applying `finalize_after_patch_decision`. The accepted patch/final candidate must reference the current pressure pass and current draft.

### `POST /v1/pbc/tasks/:taskId/continue`

This route only admits or replays a durable job. It must not perform long-running HRC work inside the HTTP request.

```text
1. Re-read projection.
2. If a job is already queued/running for this task and revision, return it.
3. If the task is waiting or terminal, return projection without a new job.
4. If an identical job completed for this revision/idempotency key, replay it.
5. Create durable PBC continuation job.
6. Return projection + job.
```

### PBC continuation worker

```text
1. Acquire job lease.
2. Re-read PBC projection and wrkf.next.
3. Stop if terminal, waiting for human input, stale, ambiguous, SoD-blocked, or max turns exceeded.
4. Determine required PBC participant work from PBC worker policy.
5. Compile prompt using PBC prompt compiler.
6. Start wrkf run idempotently.
7. Launch HRC and bind external run idempotently.
8. Wait for or recover final assistant text.
9. Parse output through PBC parser.
10. Ingest evidence and satisfy authorized obligations.
11. Finish or fail wrkf run.
12. Re-read wrkf.next.
13. Apply one safe PBC transition.
14. Deliver effects.
15. Loop until stopped.
16. Persist final job status and projection summary.
```

### `POST /v1/pbc/tasks/:taskId/dispose`

Disposition is explicit human action only.

```text
1. Authenticate human actor.
2. Re-read PBC projection.
3. Validate resolution/reason.
4. Add disposition_decision evidence.
5. Re-read wrkf.next.
6. Apply the legal dispose_from_* transition for the current phase.
7. Deliver effects.
8. Return disposed projection.
```

---

## PBC product projection

```ts
type PbcTaskProjection = {
  source: 'wrkf';
  taskId: string;
  workflowRef: 'pbc-progressive-refinement@5';

  task: {
    title?: string;
    state?: string;
    projectId?: string;
    containerId?: string;
    url?: string;
  };

  instance: {
    id: string;
    status: string;
    phase: string;
    revision: number;
    contextHash?: string; // diagnostics only
    stale?: boolean;
  };

  screen:
    | 'starting'
    | 'working'
    | 'clarification'
    | 'patch_decision'
    | 'finalized'
    | 'disposed'
    | 'blocked'
    | 'error';

  currentInput?: {
    kind: 'clarification_response' | 'patch_decision';
    prompt?: string;
    schema: unknown;
    defaults?: unknown;
  };

  artifacts: {
    intake?: ArtifactView<IntakeMetadataData>;
    behaviorNote?: ArtifactView<BehaviorNoteData>;
    preInterviewAnalysis?: ArtifactView<PreInterviewAnalysisData>;
    clarificationResponse?: ArtifactView<ClarificationResponseData>;
    draft?: ArtifactView<PbcDraftData>;
    pressurePass?: ArtifactView<PressurePassData>;
    patchDecision?: ArtifactView<PatchDecisionData>;
    final?: ArtifactView<PbcFinalData>;
    disposition?: ArtifactView<DispositionDecisionData>;
  };

  obligations: Array<{
    id: string;
    kind: string;
    status: string;
    prompt?: string;
  }>;

  actions: Array<
    | { kind: 'continue'; enabled: boolean }
    | { kind: 'submit_clarification'; enabled: boolean }
    | { kind: 'submit_patch_decision'; enabled: boolean }
    | { kind: 'dispose'; enabled: boolean }
    | { kind: 'retry_effect_delivery'; enabled: boolean }
  >;

  activeJob?: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };

  effects: Array<{
    id: string;
    kind: string;
    status: string;
    retryable?: boolean;
  }>;

  diagnostics: {
    pack: 'pbc';
    revision: number;
    legalTransitions?: string[];
    stopReason?: string;
    warnings?: string[];
  };
};
```

`contextHash` is diagnostic only. Taskboard must not submit it back for product mutations.

---

## Durable state

Use `packages/acp-state-store` rather than more in-memory defaults.

Existing `stateStore.runs` already gives durable wrkf/HRC correlation. Reuse it for participant launch state.

Add tables/repos for:

```text
wrkf_route_idempotency
  route
  task_id
  actor_hash
  idempotency_key
  body_hash
  status
  response_json
  error_json
  created_at
  updated_at

wrkf_participant_captures
  capture_key
  task_id
  workflow_ref
  wrkf_run_id
  body_hash
  evidence_ids_json
  obligation_ids_json
  status
  created_at
  updated_at

pbc_continuation_jobs
  job_id
  task_id
  workflow_ref
  revision_at_admission
  idempotency_key
  status             -- queued | running | succeeded | failed | cancelled
  attempt
  lease_owner
  lease_expires_at
  stop_reason
  result_json
  error_json
  created_at
  started_at
  finished_at
  updated_at
```

The current `PbcRouteIdempotencyStore` and `PbcCaptureStore` interfaces can be generalized and backed by these tables. Keep in-memory implementations only for tests.

Crash/replay targets:

```text
crash after wrkf.run.start:
  retry reuses same wrkf run idempotently and continues launch/bind.

crash after HRC launch before bindExternal:
  retry discovers durable ACP run; bindExternal either succeeds or marks orphaned.

crash after evidence write before transition:
  capture replay returns existing evidence IDs, re-reads next, and applies transition if still legal.

crash after transition before effect delivery:
  effect delivery replay lists pending effects and calls wrkf.effect.deliver idempotently.
```

---

## Implementation plan

### Phase 1 — Harden existing generic primitives

```text
- Make generic evidence route `ref` optional.
- Forward `data` in generic evidence route and projections.
- Add generic obligation satisfy route.
- Rename/extract deliverPbcEffects -> deliverWrkfEffects with existing behavior.
- Add server-side applyFreshTransition helper that re-reads wrkf.next.
- Update wrkf-client TypeScript types if they block evidence data/actor/role or obligation actor/role.
- Add tests for these route-level changes.
```

### Phase 2 — Extract runtime and PBC pack

```text
- Add WorkflowPack interface and registry.
- Move pbc-template-model and pbc-prompt-compiler into packs/pbc.
- Split pbc-evidence into generic evidence writer + PBC evidence policy.
- Split pbc-harness into generic runtime + PBC transition/worker policy.
- Keep old PBC routes as compatibility wrappers.
- Add grep-style test asserting generic runtime has no PBC strings.
```

### Phase 3 — Add PBC product facade

```text
- Implement /v1/pbc/tasks/:taskId/start.
- Implement /v1/pbc/tasks/:taskId get projection.
- Implement /v1/pbc/tasks/:taskId/input.
- Implement /v1/pbc/tasks/:taskId/continue.
- Implement /v1/pbc/tasks/:taskId/dispose.
- Implement /v1/pbc/jobs/:jobId.
- Add product-safe auth/actor handling.
```

### Phase 4 — Durable worker execution

```text
- Add state-store repos for route idempotency, participant captures, and PBC jobs.
- Extend participant-launch or worker path to collect final HRC assistant text.
- Parse output through PBC pack.
- Ingest evidence, finish/fail runs, apply transitions, deliver effects.
- Add crash/replay tests for each boundary.
```

### Phase 5 — Freshness and non-PBC proof

```text
- Add PBC pack freshness guard for revise loops.
- Add tests proving stale pbc_draft / pressure_pass / pbc_final cannot finalize.
- Add a small non-PBC wrkf fixture and run it through generic inspect/evidence/obligation/transition/effect routes.
```

### Phase 6 — Demote old debug routes

```text
- Keep /v1/wrkf/pbc/* behind operator/debug auth, or convert them to wrappers.
- Document /v1/pbc/* as the Taskboard/product contract.
```

---

## Acceptance criteria

### Generic runtime

```text
- No PBC identifiers in src/wrkf/runtime/**.
- GET /v1/tasks/:taskId returns structured evidence.data.
- POST /v1/tasks/:taskId/evidence accepts optional ref and forwards data.
- Generic obligation satisfy route exists.
- Server-side transition helper re-reads wrkf.next and applies with fresh revision/contextHash.
- Unknown workflows degrade to inspect/manual mode.
- A non-PBC wrkf fixture can attach, inspect, add evidence, satisfy obligations, apply transitions, and deliver effects through generic routes.
- Effect delivery continues to use wrkf.effect.deliver for supported wrkf effects.
```

### PBC pack/facade

```text
- PBC pack is selected only for pbc-progressive-refinement@5 and accepted template hash.
- PBC product routes never expose transition IDs or context hashes as required mutation inputs.
- Start installs/reuses the PBC workflow safely and does not assume task.attach idempotency.
- PBC worker launches HRC, collects final output, parses structured output, ingests evidence, finishes/fails wrkf runs, and advances legal transitions.
- Clarification and patch-decision paths require authenticated human input.
- Agent role cannot submit clarification_response or patch_decision evidence.
- Disposition requires explicit human action.
- SoD between draft and pressure pass is preserved.
- Revise-loop stale artifact reuse is blocked by pack tests.
- wrkq task state changes happen through wrkf effects.
```

### Minimum tests

```text
Generic:
  - evidence route forwards data and allows missing ref
  - projection includes evidence.data
  - obligation satisfy route delegates to wrkf
  - applyFreshTransition uses fresh next
  - deliverWrkfEffects preserves current wrkf.effect.deliver behavior
  - non-PBC fixture smoke test

PBC:
  - start idempotency and duplicate attach guard
  - behavior note -> draft path
  - clarification path
  - pressure ready -> final path
  - needs_patch -> patch decision -> final path
  - needs_patch -> patch decision -> revise path
  - too_vague -> fresh draft path
  - stale draft/pressure/final evidence rejected after revise
  - same actor SoD blocked
  - disposition explicit only
  - HRC launch/output/capture replay
  - crash after evidence before transition replay
  - effect delivery replay after transition
```
