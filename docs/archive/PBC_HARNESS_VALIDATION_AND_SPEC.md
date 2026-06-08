# WRKF PBC Execution Harness — Validation and Formal Specification

Status: validated design correction / implementation target  
Date: 2026-06-07  
Validated against: `/mnt/data/PBC_HARNESS.md` and `/mnt/data/source-repos-060726150818.zip`

## 1. Validation verdict

`PBC_HARNESS.md` is directionally correct in its architectural boundary: the harness should live in ACP as an execution/operator facade, while `wrkf` remains the workflow runtime, legality engine, workflow-state store, evidence/obligation ledger, run ledger, and effect ledger. The design is not implementable as written because several RPC shapes, run/evidence semantics, ACP integration assumptions, and PBC-specific transitions do not match the source repositories.

The corrected implementation target is a new ACP-hosted `wrkf` harness layer that delegates all state-changing workflow operations to `@wrkf/client` / `wrkf rpc --stdio`. Existing ACP workflow participant routes are not currently wrkf-backed and must either remain as legacy ACP-kernel routes or be wrapped by new wrkf-specific routes.

## 2. Source actuals used for validation

### 2.1 PBC workflow template

Source: `/mnt/data/source-repos/wrkq/pbc/workflow-template.json`

The actual workflow is:

- Template id/version: `pbc-progressive-refinement`, version `5`; kind `agent_first_workflow`; initial state `open/intake` (lines 1-10).
- Roles: `agent`, `product_owner`, `system` (lines 11-21).
- States: `open/intake`, `active/behavior_note`, `waiting/clarification`, `active/pbc_draft`, `active/pressure`, `waiting/patch_decision`, `closed/finalized`, `closed/disposed` (lines 22-63).
- Evidence kinds include `intake_metadata`, `behavior_note`, `pre_interview_analysis`, `clarification_response`, `pbc_draft`, `pressure_pass`, `patch_decision`, `pbc_final`, `disposition_decision` (lines 64-149).
- Obligation kinds include `clarification_response` and `patch_decision` (lines 152-159).
- Transitions are `normalize_feedback`, `ask_clarification`, `draft_pbc`, `answer_clarification`, `run_pressure_pass`, `finalize_ready_pbc`, `request_patch_decision`, `revise_too_vague_pbc`, `finalize_after_patch_decision`, `revise_after_patch_decision`, `dispose_from_behavior_note`, `dispose_from_pbc_draft`, and `dispose_from_pressure` (lines 160-920).
- `nextActionModel` exists in the template and contains prompt/guidance metadata, including scope metadata, role hard rules, phase guidance, and transition guidance (lines 921-1171).

### 2.2 WRKF RPC contract

Source: `/mnt/data/source-repos/wrkq/docs/wrkf-rpc.md`

The authoritative RPC contract is frozen under protocol version `2026-06-01` (lines 1-12). Transport is JSON-RPC over NDJSON stdio (lines 16-24). Method families include workflow, task, next, evidence, obligation, check, hook, transition, run, and effect namespaces (lines 101-113). Important write-side shapes:

- `wrkf.transition.apply` takes `{ task, transition, role?, actor?, expectRevision?, contextHash?, idempotencyKey?, runChecks?, dryRun? }`, not `{ taskId, transitionId }` (lines 168-177).
- `wrkf.run.start` takes `{ task, role, actor, idempotencyKey?, deliveryRef?, lane?, externalRunRef? }` (lines 179-185).
- `wrkf.run.finish` / `wrkf.run.fail` take `{ runId, summary? }` in the public contract; the Go implementation also accepts optional `status` for finish (line 188; see `internal/wrkfapi/run.go` lines 27-31).
- `wrkf.effect.claim`, `wrkf.effect.ack`, `wrkf.effect.fail`, `wrkf.effect.retry`, and `wrkf.effect.deliver` are defined; `effect.deliver` must own claim/lease handling internally (lines 190-195).
- CAS and idempotency hardening are part of the contract: stale revision, context mismatch, transition blocked, role denied, idempotency mismatch, and lease conflict are explicit error classes (lines 57-94, 203-218).

### 2.3 WRKF client and implementation

Sources:

- `/mnt/data/source-repos/wrkq/packages/wrkf-client/src/client.ts`
- `/mnt/data/source-repos/wrkq/packages/wrkf-client/src/types.ts`
- `/mnt/data/source-repos/wrkq/internal/wrkfrpc/api_registry.go`
- `/mnt/data/source-repos/wrkq/internal/workflow/service.go`
- `/mnt/data/source-repos/wrkq/internal/workflow/ledger.go`

Actual client/implementation facts:

- `WrkfClient.spawn()` shells out to `wrkf rpc --stdio` and then calls `initialize` (client.ts lines 67-90).
- `wrkf.task.inspect` uses `{ task }`; `wrkf.next` is top-level and uses `{ task, role? }` (client.ts lines 113-143; api_registry.go lines 77-94, 300-303).
- `wrkf.evidence.add` public TypeScript type currently exposes `{ task, kind, ref?, summary?, facts? }`, but the Go RPC path also accepts `data`, `actor`, and `role` (types.ts lines 278-284; api_registry.go lines 95-99; workflow/types.go lines 261-270).
- `wrkf.obligation.satisfy` takes `{ task, id, evidenceId? }` in the TypeScript client (client.ts lines 153-165).
- `wrkf.transition.apply` uses `{ task, transition, role?, actor?, expectRevision?, contextHash?, idempotencyKey?, checkIds?, runChecks?, dryRun? }` (types.ts lines 213-225; internal/wrkfapi/transition.go lines 13-24).
- `NextActionResponse` includes `instance`, `actions`, `blockedTransitions`, `openObligations`, and `pendingEffects`; revision and context hash are under `next.instance` (workflow/types.go lines 386-392).
- Adding evidence updates the instance context hash; transition application checks both revision and context hash when supplied (service.go lines 877-980; ledger.go lines 1509-1568). Therefore the harness must re-read `task.inspect` or `next` after adding evidence and before applying a transition.
- `transition.apply` enforces current-state matching, role permission, evidence requirements, obligation requirements, checks, separation of duty, guards, CAS, effects, obligation opening, and idempotency (ledger.go lines 1509-1755).
- `run.finish` records terminal status/summary; it does not accept `evidenceRefs` through the public API (internal/wrkfapi/run.go lines 27-31; ledger.go lines 2058-2088).
- `effect.deliver` claims, executes, and acknowledges/fails effects using lease semantics (ledger.go lines 1218-1288).

### 2.4 ACP actuals

Sources:

- `/mnt/data/source-repos/agent-control-plane/packages/acp-server/package.json`
- `/mnt/data/source-repos/agent-control-plane/packages/acp-server/src/handlers/workflow-participant-runs.ts`
- `/mnt/data/source-repos/agent-control-plane/packages/acp-server/src/workflow-runtime.ts`
- `/mnt/data/source-repos/agent-control-plane/packages/acp-server/src/integration/workflow-effect-reconciler.ts`

Actual ACP state:

- ACP has no `@wrkf/client` dependency in `packages/acp-server/package.json`.
- ACP does not currently have `packages/acp-server/src/wrkf/*` modules.
- The current `/workflow-participant-runs` handler uses ACP's own durable workflow kernel (`withDurableWorkflowKernel`, `kernel.startParticipantRun`, `kernel.completeParticipantRun`, `kernel.failParticipantRun`), not wrkf (workflow-participant-runs.ts lines 15-208; workflow-runtime.ts lines 1-37).
- ACP's current effect reconciler leases and delivers ACP-core effect intents from ACP state, not wrkf effects. It currently supports ACP intents such as `declare_handoff` and `wake_role_session` (workflow-effect-reconciler.ts lines 193-250).

### 2.5 Existing wrkf PBC smoke walk

Source: `/mnt/data/source-repos/wrkq/test/smoke-wrkf-rpc.sh`

The existing smoke test performs a real PBC path from intake to finalized using installed PBC preset, CAS, and evidence at each step (lines 412-483). It proves the following harness requirements:

- Install/attach PBC template; initial phase is `intake`, revision `0` (lines 415-420).
- Evidence is added before each transition; the test re-inspects because evidence writes rotate context hash (lines 425-446).
- Transition application supplies `role`, `actor`, `expectRevision`, `contextHash`, and `idempotencyKey` (lines 425-446).
- Ready path sequence is `normalize_feedback` -> `draft_pbc` -> `run_pressure_pass` -> `finalize_ready_pbc` with required evidence at each step (lines 449-458).
- Finalization requires separation of duty between `pbc_draft` and `pressure_pass`; the smoke test uses a different pressure reviewer actor (lines 453-458).
- Closed/finalized instances produce no next actions (lines 464-472).

## 3. Corrections to `PBC_HARNESS.md`

The following changes are normative for the corrected harness.

1. Use wrkf wire names exactly: `task`, `transition`, `role`, `actor`; do not use `taskId` or `transitionId` on wrkf RPC calls.
2. Call `wrkf.next({ task, role })`; actor is not accepted by the actual `wrkf.next` RPC contract.
3. Read revision and context hash from `next.instance.revision` and `next.instance.contextHash`, or from `task.inspect`'s instance projection.
4. Re-read `next` or `task.inspect` after every evidence add, obligation satisfy, effect delivery, or transition write before applying a CAS transition.
5. Do not call `wrkf.run.finish` with `outcome`, `evidenceRefs`, or an idempotency key. Finish/fail only with `runId`, optional `status` on finish, and `summary`.
6. Add explicit obligation satisfaction. `answer_clarification`, `finalize_after_patch_decision`, and `revise_after_patch_decision` require the relevant obligation to be `satisfied`; evidence alone is insufficient.
7. Treat the public TypeScript `EvidenceAddParams` as incomplete for harness needs. Widen the type or add a helper so the harness can send `data`, `actor`, and `role`, which the Go RPC path supports.
8. Do not model PBC as emitting ACP effects such as `wake_role_session`, `declare_handoff`, or `launch_participant_run`. The actual PBC template emits `set_task_state` effects. Generic wrkf effect delivery may support more effect kinds, but they are not PBC template actuals.
9. Do not assume the ACP participant-run route is wrkf-backed. It currently uses the ACP durable workflow kernel. Add new wrkf-specific routes or explicitly refactor the existing route.
10. Autopilot must stop or split actors for finalization because `finalize_ready_pbc` and `finalize_after_patch_decision` enforce separation of duty between `pbc_draft` and `pressure_pass` actors.
11. `transition.apply({ dryRun: true })` is only a diagnostic/preflight for a selected transition; the implementation returns a reduced dry-run shape, not the full transition result.
12. Disposition paths are real transitions and must be represented: `dispose_from_behavior_note`, `dispose_from_pbc_draft`, and `dispose_from_pressure`. They should be operator-only unless explicitly enabled.

## 4. Formal specification

### 4.1 Purpose

The WRKF PBC execution harness coordinates execution of `pbc-progressive-refinement@5` from ACP. It launches participant runs, compiles role-scoped prompts, ingests evidence produced by humans or runtimes, satisfies obligations when evidence fulfills them, applies legal transitions with CAS/idempotency, and delivers resulting wrkf effects.

The harness is not a workflow runtime. It must not decide transition legality, mutate workflow state directly, mutate wrkq task state directly, or maintain an independent workflow ledger. Those responsibilities belong to wrkf.

### 4.2 Normative terms

- **MUST**: required for correctness.
- **SHOULD**: required unless there is a documented implementation reason not to.
- **MAY**: optional behavior.
- **Harness**: ACP-side code that orchestrates wrkf calls.
- **Participant run**: a wrkf run record plus optional external HRC/runtime execution.
- **Task selector**: the string passed to wrkf as `task`, for example `T-00002`.
- **Actor**: wrkf wire actor string such as `human:local-human`, `agent:pbc-writer`, or `agent:pressure-reviewer`.

### 4.3 Component placement

ACP MUST add a wrkf-specific integration layer, separate from existing ACP-core workflow-runtime code.

Recommended files:

```text
agent-control-plane/packages/acp-server/src/wrkf/
  port.ts
  client-lifecycle.ts
  errors.ts
  projections.ts
  pbc-template-model.ts
  pbc-prompt-compiler.ts
  pbc-evidence.ts
  participant-launch.ts
  effect-delivery.ts
  pbc-harness.ts
```

Recommended tests:

```text
agent-control-plane/packages/acp-server/src/wrkf/__tests__/
  pbc-harness.test.ts
  pbc-prompt-compiler.test.ts
  pbc-evidence.test.ts
  effect-delivery.test.ts
  wrkf-error-map.test.ts
```

### 4.4 Dependencies and configuration

ACP server MUST depend on `@wrkf/client` or a local workspace/link to `wrkq/packages/wrkf-client`.

The harness MUST be configurable with:

```ts
interface WrkfHarnessConfig {
  wrkfCommand: string;              // default: "wrkf"
  wrkfArgs: string[];               // default: ["rpc", "--stdio"]
  protocolVersion: "2026-06-01";
  defaultWorkflowRef: "pbc-progressive-refinement@5";
  defaultAgentActor: string;
  defaultPressureActor?: string;    // must differ from draft actor for SoD-finalizing paths
  defaultProductOwnerActor?: string;
  defaultLane: "pbc-refinement";
  pressureLane: "pbc-pressure";
  productOwnerLane: "pbc-product-owner";
  maxAutopilotTurns: number;
}
```

The harness MUST initialize the wrkf client using the protocol version declared by `@wrkf/client` / wrkf RPC and fail startup if the server reports an incompatible protocol version.

### 4.5 WRKF port

The ACP implementation MUST hide raw `@wrkf/client` behind a narrow port so the harness can be tested with a fake client.

```ts
type TaskSelector = string;
type Role = "agent" | "product_owner" | "system";
type ActorId = string;

type WrkfPort = {
  workflowShow(input: { ref: string }): Promise<WorkflowShowResult>;

  taskInspect(input: { task: TaskSelector }): Promise<TaskInspectResult>;
  next(input: { task: TaskSelector; role?: Role }): Promise<NextActionResponse>;

  evidenceAdd(input: {
    task: TaskSelector;
    kind: string;
    ref?: string;
    summary?: string;
    facts?: Record<string, unknown>;
    data?: unknown;
    actor?: ActorId;
    role?: Role;
  }): Promise<EvidenceRecord>;

  obligationList(input: { task: TaskSelector }): Promise<ObligationRecord[]>;
  obligationSatisfy(input: {
    task: TaskSelector;
    id: string;
    evidenceId?: string;
  }): Promise<ObligationRecord>;

  transitionApply(input: {
    task: TaskSelector;
    transition: string;
    role?: Role;
    actor?: ActorId;
    expectRevision?: number;
    contextHash?: string;
    idempotencyKey?: string;
    runChecks?: boolean;
    dryRun?: boolean;
  }): Promise<TransitionApplyResult>;

  runStart(input: {
    task: TaskSelector;
    role: Role;
    actor: ActorId;
    idempotencyKey?: string;
    deliveryRef?: string;
    lane?: string;
    externalRunRef?: string;
  }): Promise<RunRecord>;

  runBindExternal(input: {
    runId: string;
    externalRunRef: string;
    deliveryRef?: string;
    lane?: string;
    idempotencyKey?: string;
  }): Promise<RunRecord>;

  runFinish(input: {
    runId: string;
    status?: "completed" | "failed" | "cancelled";
    summary?: string;
  }): Promise<RunRecord>;

  runFail(input: { runId: string; summary?: string }): Promise<RunRecord>;

  effectList(input: { task?: TaskSelector; all?: boolean }): Promise<EffectRecord[]>;
  effectDeliver(input: { effectId: string; adapter?: string }): Promise<EffectRecord>;
};
```

The port MUST use wrkf wire names, not ACP-local names. ACP route DTOs may expose `taskId`, but route handlers MUST translate to wrkf `task` before calling the port.

### 4.6 Public ACP routes

The implementation SHOULD add wrkf-specific routes rather than silently changing the existing ACP-core participant-run route.

Recommended route set:

```text
GET  /v1/wrkf/pbc/tasks/:task/inspect
POST /v1/wrkf/pbc/tasks/:task/run-step
POST /v1/wrkf/pbc/tasks/:task/approve-transition
POST /v1/wrkf/pbc/tasks/:task/run-until-blocked
POST /v1/wrkf/effects/deliver
```

#### 4.6.1 Inspect

`GET /v1/wrkf/pbc/tasks/:task/inspect`

Returns current wrkf instance projection, next actions, blocked transitions, open obligations, pending effects, and the PBC template metadata needed by UI/operator surfaces.

The route MUST be read-only.

#### 4.6.2 Run step

`POST /v1/wrkf/pbc/tasks/:task/run-step`

Runs exactly one participant action and returns a refreshed wrkf projection. It MUST NOT apply a transition unless explicitly requested by `transitionPolicy`.

```ts
interface RunStepRequest {
  role?: Role;
  actor: ActorId;
  scopeRef?: string;
  laneRef?: string;
  idempotencyKey: string;
  launchRuntime?: boolean;
  participantOutput?: ParticipantOutput; // for human/offline mode
  transitionPolicy?: "none" | "single-safe";
}
```

#### 4.6.3 Approve transition

`POST /v1/wrkf/pbc/tasks/:task/approve-transition`

Applies one operator-approved transition with CAS.

```ts
interface ApproveTransitionRequest {
  transition: string;
  role?: Role;
  actor: ActorId;
  idempotencyKey: string;
  runChecks?: boolean;
}
```

The handler MUST re-read `next` immediately before applying the transition and use the current `next.instance.revision` and `next.instance.contextHash`.

#### 4.6.4 Run until blocked

`POST /v1/wrkf/pbc/tasks/:task/run-until-blocked`

Runs conservative autopilot until a closed state, human/product-owner obligation, ambiguous transition, SoD boundary, runtime failure, stale/context error after retry, or `maxTurns` is reached.

```ts
interface RunUntilBlockedRequest {
  actor: ActorId;
  pressureActor?: ActorId;
  productOwnerActor?: ActorId;
  idempotencyKey: string;
  maxTurns?: number;
  allowDisposition?: boolean;
  allowProductOwnerSimulation?: boolean;
}
```

#### 4.6.5 Deliver effects

`POST /v1/wrkf/effects/deliver`

Delivers pending wrkf effects. For PBC, this primarily delivers `set_task_state` effects emitted by transitions.

```ts
interface DeliverEffectsRequest {
  task?: TaskSelector;
  effectId?: string;
  adapter?: string;        // default: "acp"
  maxEffects?: number;
}
```

The route MUST use `wrkf.effect.deliver` unless a custom adapter explicitly needs manual claim/ack/fail. Manual effect delivery MUST preserve lease-token semantics.

### 4.7 Harness response model

All mutating routes SHOULD return a normalized projection:

```ts
interface PbcHarnessResult {
  task: TaskSelector;
  workflowRef: "pbc-progressive-refinement@5";
  instance: {
    status: string;
    phase: string;
    revision: number;
    contextHash: string;
    stale?: boolean;
  };
  next: {
    actions: NextAction[];
    blockedTransitions: unknown[];
    openObligations: ObligationRecord[];
    pendingEffects: EffectRecord[];
  };
  runs: {
    started?: RunRecord;
    boundExternal?: RunRecord;
    finished?: RunRecord;
    failed?: RunRecord;
  };
  evidenceAdded: EvidenceRecord[];
  obligationsSatisfied: ObligationRecord[];
  transitionApplied?: TransitionApplyResult;
  effectsDelivered: EffectRecord[];
  stopReason?: string;
  diagnostics: string[];
}
```

The response MUST include the latest known revision and context hash after any write.

### 4.8 Prompt compiler

The harness MUST compile prompts from the installed PBC template, not hard-code phase text in ACP.

Input to compiler:

```ts
interface PromptCompileInput {
  template: PbcTemplateWithNextActionModel;
  task: TaskSelector;
  role: Role;
  actor: ActorId;
  scopeRef?: string;
  laneRef?: string;
  next: NextActionResponse;
  evidenceSummaries: EvidenceRecord[];
  obligations: ObligationRecord[];
}
```

Compiler behavior:

1. Load `nextActionModel` from `wrkf.workflow.show({ ref: "pbc-progressive-refinement@5" })`.
2. Select current phase guidance by `next.instance.state.status` and `next.instance.state.phase`.
3. Add role hard rules for the requested role.
4. Add transition guidance for candidate next actions and blocked transitions.
5. Include open obligations and their required evidence kinds.
6. Include the exact participant output schema.
7. Include guardrails: no direct workflow mutation, no transition application, evidence must be grounded in task context, and product-owner obligations must not be fabricated by the agent role.

Participant output schema:

```ts
interface ParticipantOutput {
  evidence: Array<{
    kind: string;
    ref?: string;
    summary?: string;
    facts?: Record<string, unknown>;
    data?: unknown;
  }>;
  satisfyObligations?: Array<{
    obligationId?: string;
    obligationKind?: string;
    evidenceIndex: number;
    reason?: string;
  }>;
  proposedTransition?: string;
  summary?: string;
}
```

The compiler MUST NOT tell the participant to call wrkf directly. The participant produces evidence and recommendations; the harness writes to wrkf.

### 4.9 Evidence ingestion

For each participant-produced evidence record, the harness MUST call:

```ts
wrkf.evidence.add({
  task,
  kind,
  ref,
  summary,
  facts,
  data,
  actor,
  role
})
```

The harness MUST validate evidence against the PBC template before sending it when practical, but wrkf remains authoritative and may reject invalid evidence. Required facts:

- `pre_interview_analysis.facts.clarification_needed` is boolean.
- `pressure_pass.facts.verdict` is one of `ready`, `needs_patch`, `too_vague`.
- `patch_decision.facts.route` is one of `finalize`, `revise`.
- `disposition_decision.facts.resolution` is one of `wont_fix`, `duplicate`, `unclear`, `out_of_scope`.

The harness SHOULD encode external runtime/run identity in evidence `data` until wrkf exposes first-class run-to-evidence linking in the public RPC API.

### 4.10 Obligation handling

The harness MUST explicitly satisfy obligations after adding evidence when the participant output claims to answer an obligation or when PBC phase semantics unambiguously require it.

Algorithm:

1. Add evidence.
2. Re-list obligations via `wrkf.obligation.list({ task })`.
3. Match open obligation by id if supplied; otherwise by kind and blocking status.
4. Call `wrkf.obligation.satisfy({ task, id, evidenceId })`.
5. Re-read `next` before applying any transition.

Required PBC obligation cases:

- `waiting/clarification`: `clarification_response` obligation MUST be satisfied before `answer_clarification`.
- `waiting/patch_decision`: `patch_decision` obligation MUST be satisfied before `finalize_after_patch_decision` or `revise_after_patch_decision`.

The agent role MUST NOT synthesize product-owner obligation evidence unless `allowProductOwnerSimulation` is explicitly enabled for tests or local demos.

### 4.11 Run lifecycle

Participant run lifecycle:

1. Start wrkf run:

```ts
const run = await wrkf.run.start({
  task,
  role,
  actor,
  idempotencyKey: `${baseKey}:run:${actionId}:${revision}`,
  deliveryRef: scopeRef,
  lane: laneRef
});
```

2. If launching HRC/runtime, launch with the compiled prompt and bind the external run:

```ts
await wrkf.run.bindExternal({
  runId: run.id,
  externalRunRef: `hrc:${hrcRunId}`,
  deliveryRef: scopeRef,
  lane: laneRef,
  idempotencyKey: `${baseKey}:run:${run.id}:bind`
});
```

3. Ingest evidence and satisfy obligations.

4. Finish or fail the wrkf run:

```ts
await wrkf.run.finish({
  runId: run.id,
  status: "completed",
  summary
});
```

or:

```ts
await wrkf.run.fail({ runId: run.id, summary });
```

The harness MUST NOT pass `evidenceRefs`, `outcome`, or finish idempotency keys to `wrkf.run.finish`.

### 4.12 Transition application

The harness MUST apply transitions only through wrkf:

```ts
const latest = await wrkf.next({ task, role });

const result = await wrkf.transition.apply({
  task,
  transition,
  role,
  actor,
  expectRevision: latest.instance.revision,
  contextHash: latest.instance.contextHash,
  idempotencyKey: `${baseKey}:transition:${transition}:${latest.instance.revision}`,
  runChecks: false
});
```

Rules:

- The harness MUST re-read `next` after every evidence/obligation/effect write before applying a transition.
- The harness MUST NOT infer legality from local state. It MAY use `next.actions` to choose a candidate, but wrkf is authoritative.
- The harness MUST surface wrkf blocked-transition diagnostics to the caller instead of hiding them.
- The harness MAY use `dryRun: true` only for selected-transition diagnostics; it MUST NOT treat dry-run output as a committed transition result.

### 4.13 PBC state policy

This table is normative for PBC-specific harness behavior.

| State | Harness behavior | Autopilot transition policy |
|---|---|---|
| `open/intake` | Produce/add `intake_metadata`. | Apply `normalize_feedback` when legal. |
| `active/behavior_note` | Produce/add `behavior_note` and `pre_interview_analysis`. | If `clarification_needed=true`, apply `ask_clarification` and stop on product-owner obligation. If `false`, apply `draft_pbc`. Disposition is operator-only. |
| `waiting/clarification` | Require product-owner `clarification_response`; satisfy obligation. | Apply `answer_clarification` only after obligation is satisfied; otherwise stop. |
| `active/pbc_draft` | Produce/add `pbc_draft`. | Apply `run_pressure_pass`. Disposition is operator-only. |
| `active/pressure` | Produce/add `pressure_pass` with verdict. | `ready`: require/add `pbc_final`, then apply `finalize_ready_pbc` if SoD is satisfied. `needs_patch`: apply `request_patch_decision` and stop on product-owner obligation. `too_vague`: apply `revise_too_vague_pbc`. Disposition is operator-only. |
| `waiting/patch_decision` | Require product-owner `patch_decision`; satisfy obligation. | `route=finalize`: require/add `pbc_final`, then apply `finalize_after_patch_decision` if SoD is satisfied. `route=revise`: apply `revise_after_patch_decision`. Otherwise stop. |
| `closed/finalized` | Return final projection. | Stop. |
| `closed/disposed` | Return final projection. | Stop. |

Separation-of-duty policy:

- The actor that writes `pressure_pass` MUST differ from the actor that wrote `pbc_draft` for finalization transitions.
- If autopilot cannot guarantee distinct actors, it MUST stop before finalization and return a `requires_distinct_pressure_reviewer` stop reason.

Disposition policy:

- `dispose_from_behavior_note`, `dispose_from_pbc_draft`, and `dispose_from_pressure` MUST require explicit operator approval unless `allowDisposition` is true.

### 4.14 Effect delivery

After every committed transition, the harness SHOULD deliver pending wrkf effects for the task.

For PBC v5, expected transition effects are `set_task_state`. The harness MUST let wrkf deliver them via:

```ts
await wrkf.effect.deliver({ effectId, adapter: "acp" });
```

Manual claim/ack/fail MAY be implemented for custom ACP adapters, but then the implementation MUST:

1. Claim the effect and retain the returned lease token.
2. Perform the side effect exactly once or idempotently.
3. Ack with matching lease token and receipt, or fail with matching lease token and error.
4. Treat `WRKF_LEASE_CONFLICT` as non-fatal and re-list later.

The harness MUST NOT directly mutate wrkq task state as a substitute for wrkf effect delivery.

### 4.15 Idempotency and concurrency

The harness MUST use deterministic idempotency keys for wrkf writes and MUST maintain request-body hashing at the ACP route layer.

Recommended key scheme:

```text
{routeKey}:run:{actionId}:{revision}
{routeKey}:run:{runId}:bind
{routeKey}:transition:{transitionId}:{revision}
{routeKey}:effect:{effectId}:deliver
```

Rules:

- If ACP receives the same route idempotency key with a different request hash, return conflict.
- If wrkf returns `WRKF_IDEMPOTENCY_MISMATCH`, return HTTP 409.
- If wrkf returns stale revision or context mismatch, re-read once and retry only if the selected operation is still legal and the request is semantically unchanged. Otherwise stop and return the fresh projection.
- Never retry a participant runtime launch unless the external launch layer is itself idempotent or a previous `externalRunRef` can be recovered.

### 4.16 Error mapping

| WRKF error | HTTP/status behavior | Harness behavior |
|---|---:|---|
| `WRKF_STALE_REVISION` | 409 | Re-read once; retry only if still safe. |
| `WRKF_CONTEXT_MISMATCH` | 409 | Re-read once; retry only if still safe. |
| `WRKF_TRANSITION_BLOCKED` | 422 | Return blockers and current `next`. |
| `WRKF_ROLE_DENIED` | 403 | Return role/actor denial. |
| `WRKF_IDEMPOTENCY_MISMATCH` | 409 | Return conflict; do not retry with new key silently. |
| `WRKF_LEASE_CONFLICT` | 409/202 | Skip effect and re-list; not a fatal task failure. |
| Validation errors | 400/422 | Return invalid evidence/transition details. |
| Not found | 404 | Return missing task/workflow/run/effect. |
| Runtime launch failure | 502/424 | Fail wrkf run if run was started; return projection. |

### 4.17 Autopilot algorithm

```ts
async function runUntilBlocked(input: RunUntilBlockedRequest): Promise<PbcHarnessResult> {
  let turns = 0;
  let result = emptyResult(input.task);

  while (turns++ < maxTurns(input)) {
    const next = await wrkf.next({ task: input.task, role: "agent" });
    result = result.withNext(next);

    if (next.instance.state.status === "closed") return result.stop("closed");
    if (next.instance.stale) return result.stop("stale_instance");

    await deliverPendingEffects(input.task, result);

    const state = `${next.instance.state.status}/${next.instance.state.phase}`;

    if (state === "waiting/clarification") {
      if (!input.allowProductOwnerSimulation) return result.stop("requires_product_owner_clarification");
      await runProductOwnerClarificationStep(input, result);
      continue;
    }

    if (state === "waiting/patch_decision") {
      if (!input.allowProductOwnerSimulation) return result.stop("requires_product_owner_patch_decision");
      await runProductOwnerPatchDecisionStep(input, result);
      continue;
    }

    const participant = await runOneParticipantAction(input, next, result);
    await ingestEvidenceAndSatisfyObligations(input.task, participant, result);

    const fresh = await wrkf.next({ task: input.task, role: "agent" });
    const transition = chooseSingleSafePbcTransition(fresh, input);

    if (!transition) return result.withNext(fresh).stop("blocked_or_ambiguous");

    if (isFinalization(transition) && !hasDistinctPressureActor(fresh, input)) {
      return result.withNext(fresh).stop("requires_distinct_pressure_reviewer");
    }

    await wrkf.transition.apply({
      task: input.task,
      transition,
      role: "agent",
      actor: actorForTransition(transition, input),
      expectRevision: fresh.instance.revision,
      contextHash: fresh.instance.contextHash,
      idempotencyKey: transitionKey(input, transition, fresh.instance.revision),
      runChecks: false
    });
  }

  return result.stop("max_turns");
}
```

`chooseSingleSafePbcTransition` MUST use the PBC state policy table above. It MUST NOT choose disposition transitions unless `allowDisposition` is true. It MUST stop on multiple legal non-deterministic transition actions unless PBC facts uniquely select one path.

### 4.18 Conformance tests

The implementation is conformant only if the following pass.

#### Unit tests with fake `WrkfPort`

- `task.inspect`, `next`, `evidence.add`, and `transition.apply` are called with `task`/`transition` wire names, never `taskId`/`transitionId`.
- `wrkf.next` is called without actor.
- Revision/context hash are read from `next.instance`.
- Evidence add is followed by a fresh `next`/`inspect` before transition application.
- `wrkf.run.finish` is never called with `evidenceRefs`, `outcome`, or an idempotency key.
- `waiting/clarification` satisfies `clarification_response` obligation before `answer_clarification`.
- `waiting/patch_decision` satisfies `patch_decision` obligation before patch-decision transitions.
- Autopilot stops when finalization would violate SoD.
- PBC effect delivery calls `wrkf.effect.deliver` for pending `set_task_state` effects.
- Disposition transitions require explicit approval by default.

#### Integration tests against real wrkf

Mirror the existing wrkf smoke path through the harness:

1. Install/show `pbc-progressive-refinement@5`.
2. Attach a wrkq task.
3. Execute ready path: `normalize_feedback` -> `draft_pbc` -> `run_pressure_pass` -> `finalize_ready_pbc`.
4. Verify closed/finalized and no next actions.
5. Verify `set_task_state` effects are delivered.
6. Verify SoD requires a distinct pressure reviewer actor.

Additional required integration paths:

- Clarification path: `ask_clarification` -> product-owner `clarification_response` -> satisfy obligation -> `answer_clarification`.
- Patch path: `request_patch_decision` -> product-owner `patch_decision` route `finalize` -> satisfy obligation -> `finalize_after_patch_decision`.
- Revise path: `pressure_pass.verdict=too_vague` -> `revise_too_vague_pbc`.
- Patch revise path: `patch_decision.route=revise` -> `revise_after_patch_decision`.
- Disposition path with explicit approval.
- Stale revision/context mismatch path.
- Idempotency replay and idempotency mismatch path.
- Effect lease conflict path.

## 5. Implementation note on validation limits

This validation is primarily static source validation. Targeted Go test execution was attempted in this environment but timed out without producing useful stdout, so this document does not claim that the source test suite completed here. The strongest executable evidence in the repository is the existing `test/smoke-wrkf-rpc.sh` PBC path, which demonstrates the expected wrkf call sequence and CAS behavior.

## 6. Minimal acceptance checklist

A first acceptable implementation MUST satisfy all of the following:

- ACP server has a real wrkf client dependency and a wrkf-specific port.
- Existing ACP-core workflow participant routes are not presented as wrkf-backed unless refactored.
- PBC template metadata is read from wrkf and used by the prompt compiler.
- Harness writes evidence via `wrkf.evidence.add` with actor/role and valid facts.
- Harness explicitly satisfies obligations for clarification and patch-decision waiting states.
- Harness applies transitions only through `wrkf.transition.apply` with fresh revision/context hash.
- Harness starts/binds/finishes wrkf runs using actual run RPC shapes.
- Harness delivers PBC `set_task_state` effects via `wrkf.effect.deliver`.
- Harness honors SoD and stops before unsafe finalization.
- Harness exposes blocked/stopped states instead of fabricating progress.
