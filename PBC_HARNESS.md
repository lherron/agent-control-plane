Yes: put the harness in **ACP**, but make it an **execution harness / operator facade**, not a workflow runtime. The harness should run the PBC workflow by repeatedly asking wrkf what is true and legal, launching HRC/agent sessions when needed, recording evidence through wrkf, applying wrkf transitions, and delivering wrkf effects. ACP should never own a parallel PBC state machine.

The best component name would be something like:

```text
packages/acp-server/src/wrkf/pbc-harness.ts
```

or more generally:

```text
packages/acp-server/src/wrkf/workflow-harness.ts
packages/acp-server/src/wrkf/pbc-runner.ts
```

The general harness should be workflow-agnostic; the PBC-specific layer should mostly supply prompt compilation, evidence parsing, and policy defaults.

## Proposed ACP component

```text
ACP
└── wrkf/
    ├── port.ts                     # Thin typed wrapper over @wrkf/client
    ├── client-lifecycle.ts          # Starts wrkf rpc --stdio once
    ├── errors.ts                    # Maps wrkf errors to ACP HTTP errors
    ├── launch-context.ts            # Builds HRC launch prompt/context
    ├── participant-launch.ts        # wrkf.run.start -> HRC launch -> wrkf.run.bindExternal
    ├── effect-delivery.ts           # wrkf.effect.claim -> deliver -> ack/fail
    ├── workflow-harness.ts          # Generic inspect/next/evidence/transition loop
    └── pbc-harness.ts               # PBC-specific prompt/evidence/policy adapter
```

This matches the refactor direction: wrkf owns workflow truth, revisions, transitions, evidence, obligations, effects, runs, idempotency, and stale-revision checks; ACP owns HTTP/CLI facade, HRC launch, prompt construction, effect delivery, dashboard projections, and execution telemetry only.  [oai_citation:0‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0) The docs also explicitly say retained ACP workflow surfaces should be wrappers over wrkf, not a compatibility shim around ACP’s old workflow kernel.  [oai_citation:1‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

## What the harness is

The harness is a **run loop around wrkf**, not a state machine.

Its job:

```text
inspect current task/workflow
ask wrkf for legal next actions
compile a role/scope-aware agent prompt
start or reuse a wrkf run
launch HRC/agent runtime
collect structured agent output
write evidence to wrkf
ask wrkf for next again
optionally apply a transition through wrkf
deliver any wrkf effects through ACP adapters
repeat until closed, blocked, failed, or awaiting human input
```

Its non-job:

```text
do not evaluate transition legality
do not store workflow state
do not store a parallel workflow ledger
do not decide that a transition is valid because ACP thinks evidence exists
do not keep ACP workflow definitions/tasks/effects/obligations
```

The refactor document is explicit that ACP must not compute legal workflow transitions, store a parallel workflow ledger, or persist alternate workflow truth.  [oai_citation:2‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

## Core harness API

I would expose a single high-level ACP service:

```ts
type RunPbcWorkflowInput = {
  taskId: string
  workflowRef?: 'pbc-progressive-refinement@5'
  role?: 'agent' | 'product_owner'
  actor: {
    kind: 'human' | 'agent' | 'system'
    id: string
  }

  mode: 'observe' | 'step' | 'autopilot'
  scopeRef?: string
  laneRef?: string

  maxTurns?: number
  idempotencyKey: string
  launchRuntime?: boolean
}

type RunPbcWorkflowResult = {
  source: 'wrkf'
  taskId: string
  instanceId: string
  workflowRef: string
  revision: number
  contextHash?: string

  state: {
    status: string
    phase: string
  }

  run?: {
    wrkfRunId: string
    hrcRunId?: string
    scopeRef?: string
    laneRef?: string
    replay: boolean
  }

  nextActions: WrkfNextAction[]
  evidenceWritten: EvidenceRef[]
  transitionApplied?: {
    transitionId: string
    from: string
    to: string
    revision: number
  }

  blockers: Array<{
    kind: 'missing_evidence' | 'open_obligation' | 'stale_context' | 'role_denied' | 'human_required'
    message: string
  }>

  effectsDelivered: Array<{
    effectId: string
    kind: string
    status: 'delivered' | 'failed'
    receipt?: unknown
  }>

  terminal: boolean
}
```

Modes:

```text
observe:
  show task, state, next actions, blockers, obligations, evidence, effects;
  do not launch or mutate.

step:
  launch one agent/human participant run;
  record evidence;
  preview transition;
  require operator approval before transition.apply.

autopilot:
  loop while policy permits:
    launch agent run,
    record evidence,
    apply exactly-one legal transition,
    deliver effects,
    stop on human obligation / ambiguity / error / closed state.
```

For PBC, I would start with `step` as the default. `autopilot` should be opt-in because the workflow includes product-owner decision points.

## Harness loop

The generic loop should look like this:

```ts
export async function runWorkflowHarness(input: HarnessInput): Promise<HarnessResult> {
  const task = await wrkf.task.inspect({ taskId: input.taskId })
  const next = await wrkf.next({
    taskId: input.taskId,
    role: input.role,
    actor: input.actor,
  })

  if (input.mode === 'observe') {
    return renderProjection(task, next)
  }

  const action = chooseHarnessAction(next, input.mode)

  if (!action) {
    return blockedResult(task, next)
  }

  const run = await participantLaunch.start({
    taskId: input.taskId,
    role: action.role,
    actor: input.actor,
    scopeRef: input.scopeRef ?? deriveScopeRef(input, task, action),
    laneRef: input.laneRef ?? action.scopeHint?.lane,
    idempotencyKey: `${input.idempotencyKey}:run:${action.id}`,
    launchRuntime: input.launchRuntime ?? true,
    prompt: promptCompiler.build({
      task,
      next,
      action,
      role: action.role,
      actor: input.actor,
    }),
  })

  const output = await collectParticipantOutput(run)

  const evidenceRefs = await writeEvidenceFromOutput({
    taskId: input.taskId,
    runId: run.wrkfRun.id,
    output,
    expectedEvidence: action.expectedEvidence,
  })

  await wrkf.run.finish({
    runId: run.wrkfRun.id,
    outcome: 'completed',
    evidenceRefs,
    idempotencyKey: `${input.idempotencyKey}:run:${action.id}:finish`,
  })

  const afterEvidence = await wrkf.next({
    taskId: input.taskId,
    role: input.role,
    actor: input.actor,
  })

  if (input.mode === 'step') {
    return previewTransition(task, afterEvidence, evidenceRefs)
  }

  const transition = chooseAutopilotTransition(afterEvidence)

  if (!transition) {
    return blockedResult(task, afterEvidence)
  }

  const applied = await wrkf.transition.apply({
    taskId: input.taskId,
    transitionId: transition.id,
    role: input.role,
    actor: input.actor,
    expectRevision: afterEvidence.revision,
    contextHash: afterEvidence.contextHash,
    idempotencyKey: `${input.idempotencyKey}:transition:${transition.id}:${afterEvidence.revision}`,
  })

  const effects = await effectDelivery.deliverTick({
    taskId: input.taskId,
    limit: 25,
  })

  return summarize(applied, effects)
}
```

The key is `chooseHarnessAction` and `chooseAutopilotTransition` must not implement workflow legality. They should only select from wrkf-provided next actions and stop when ambiguous.

## PBC-specific policy

For PBC, the harness policy should be conservative:

| PBC state | Harness behavior |
|---|---|
| `open/intake` | Launch agent to normalize feedback and produce `intake_metadata`; then apply `normalize_feedback`. |
| `active/behavior_note` | Launch agent to produce `behavior_note` and `pre_interview_analysis`. If clarification needed, apply `ask_clarification`; otherwise apply `draft_pbc`. |
| `waiting/clarification` | Do not launch agent as if it can continue. Surface product-owner obligation and optionally launch/request PO input. |
| `active/pbc_draft` | Launch agent to produce `pbc_draft`; apply `run_pressure_pass`. |
| `active/pressure` | Launch reviewer/agent pressure pass. If `ready`, require `pbc_final` and apply `finalize_ready_pbc`. If `needs_patch`, apply `request_patch_decision`. If `too_vague`, apply `revise_too_vague_pbc`. |
| `waiting/patch_decision` | Stop agent autopilot. Surface PO obligation. Resume only when PO emits `patch_decision`. |
| `closed/finalized` | Stop. Show final PBC and delivered effects. |
| `closed/disposed` | Stop. Show disposition reason. |

The harness can automate the agent-owned branches, but it should stop at product-owner obligations unless a bound PO actor is present.

## ACP route surface

I would add these ACP routes:

```text
POST /v1/wrkf/pbc-harness/start
POST /v1/wrkf/pbc-harness/:sessionId/step
POST /v1/wrkf/pbc-harness/:sessionId/approve-transition
POST /v1/wrkf/pbc-harness/:sessionId/stop
GET  /v1/wrkf/pbc-harness/:sessionId
```

But I would make `sessionId` an ACP **execution session**, not workflow truth. It can store UI/harness state like open websocket connections, HRC runtime id, current operator, and display preferences. The actual workflow state comes from wrkf every time.

For a minimal first cut, skip durable harness sessions and expose just:

```text
POST /v1/wrkf/pbc/run-step
POST /v1/wrkf/pbc/run-until-blocked
GET  /v1/wrkf/tasks/:taskId
```

The docs already identify `POST /v1/workflow-participant-runs` as a wrkf-backed launch helper and `GET /v1/tasks/:taskId` as a read facade over wrkf task inspection and next actions.  [oai_citation:3‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_00000000d28071fd91d336096de40c0d)

## Participant launch component

The harness should call a reusable `participant-launch.ts` service rather than embedding HRC launch logic.

Contract:

```ts
type StartWorkflowParticipantRunInput = {
  taskId: string
  role: string
  actor: Actor
  scopeRef: string
  laneRef?: string
  initialPrompt: string
  idempotencyKey: string
  launchRuntime: boolean
}

type StartWorkflowParticipantRunResult = {
  source: 'wrkf'
  taskId: string
  instanceId: string
  workflowRef: string
  revision: number
  contextHash?: string
  wrkfRun: WrkfRun
  launch?: {
    hrcRunId: string
    hostSessionId?: string
    runtimeId?: string
    launchId?: string
    scopeRef: string
    laneRef: string
    generation?: number
  }
  replay: boolean
}
```

This is basically the preferred response shape already proposed in the refactor doc.  [oai_citation:4‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0) The service responsibilities are also already spelled out: start or replay wrkf run, construct deterministic session ref, create ACP runStore record only for HRC dispatch telemetry/fencing, build launch prompt from wrkf projection, launch HRC, bind external HRC ref back to wrkf, and return a source-tagged result.  [oai_citation:5‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

## Prompt compiler

The PBC harness needs a prompt compiler, not hardcoded workflow logic.

```ts
type PbcPromptCompilerInput = {
  task: WrkfTaskProjection
  instance: WrkfInstanceProjection
  next: WrkfNextResponse
  selectedAction: WrkfNextAction
  role: 'agent' | 'product_owner'
  actor: Actor
  scopeRef: string
  laneRef?: string
  evidenceSummary: EvidenceSummary[]
  obligations: ObligationSummary[]
}

type PbcPromptCompilerOutput = {
  initialPrompt: string
  expectedOutputSchema: JsonSchema
}
```

The prompt should tell the agent:

```text
- canonical workflow state
- legal next action from wrkf
- required evidence kind and facts
- current blockers/obligations
- exact output schema
- hard rules: do not invent PO answers, do not mutate state outside wrkf, cite current artifact hashes, stop when blocked
```

The harness should request structured output, for example:

```json
{
  "evidence": [
    {
      "kind": "pre_interview_analysis",
      "facts": {
        "clarification_needed": false
      },
      "data": {
        "rationale": "..."
      },
      "artifactRefs": []
    }
  ],
  "proposedTransition": "draft_pbc",
  "notes": "Ready to draft compact PBC."
}
```

Then ACP validates only the **shape expected by the harness**, not the workflow legality. It passes evidence to wrkf, then asks wrkf what is legal.

## Effect delivery as a sibling harness loop

Do not let the PBC harness directly mutate wrkq task state. It should either call the shared effect reconciler after transitions or enqueue a delivery tick.

The refactor doc proposes replacing the old ACP workflow-effect reconciler with a wrkf effect reconciler that claims effects from wrkf, delivers them into ACP/HRC/coordination, and then ack/fails with the wrkf lease token.  [oai_citation:6‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

So after every successful transition:

```ts
await deps.wrkfEffects.deliverTick({
  taskId,
  adapter: 'acp',
  limit: 25,
})
```

This is where effects like these would be handled:

```text
set_task_state
wake_role_session
declare_handoff
launch_participant_run
```

The PBC harness should see effect status in its projection, but it should not own effect truth.

## Human-in-the-loop harness UI

For PBC, this is important. The harness should have an operator view that shows:

```text
Task
Workflow state
Current next actions
Required evidence
Open obligations
Recent evidence
Recent transitions
Pending/failed effects
Active wrkf/HRC runs
```

That aligns with the interactive workflow harness concept: surface the authoritative workflow view, stream workflow events, allow feedback to the supervisor/agent, and optionally preview/approve the supervisor’s intended next action.  [oai_citation:7‡acp-interactive-workflows.md](sediment://file_0000000016ac71f7ab2f86aa1fe937ca)

For `waiting/clarification` and `waiting/patch_decision`, the UI should present a very small PO form:

```text
Clarification response:
  answer: string

Patch decision:
  route: finalize | revise
  rationale?: string
```

Submitting that form writes wrkf evidence and satisfies the corresponding obligation. It should not “unblock” anything in ACP state.

## Autopilot guardrails

`run-until-blocked` should stop when any of these happens:

```text
- wrkf state is closed/*
- more than one transition is legal and no policy selects one
- required role is product_owner and current actor is agent
- an obligation is open and blocking
- wrkf returns stale revision/context mismatch
- effect delivery fails non-retryably
- participant output cannot be parsed into expected evidence
- SoD policy says the same actor/run cannot produce the next evidence
```

That gives you safe automation without turning ACP into a hidden workflow engine.

## Suggested implementation phases

**Phase 1 — Thin wrkf port**

Add:

```text
packages/acp-server/src/wrkf/port.ts
packages/acp-server/src/wrkf/client-lifecycle.ts
packages/acp-server/src/wrkf/errors.ts
```

Do only typed calls and error mapping. Do not add PBC logic yet. The refactor plan already calls for this exact wrkf port/lifecycle layer and fake/real-process tests.  [oai_citation:8‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

**Phase 2 — Read-only harness**

Add:

```text
GET /v1/wrkf/tasks/:taskId
POST /v1/wrkf/pbc/inspect
```

Return:

```json
{
  "source": "wrkf",
  "task": {},
  "workflow": {},
  "next": [],
  "evidence": [],
  "obligations": [],
  "effects": [],
  "runs": []
}
```

No mutation. This gets the operator view right first.

**Phase 3 — Participant launch**

Implement:

```text
packages/acp-server/src/wrkf/participant-launch.ts
packages/acp-server/src/wrkf/launch-context.ts
```

Route:

```text
POST /v1/workflow-participant-runs
```

It should call:

```text
wrkf.run.start
build prompt
launch HRC
wrkf.run.bindExternal
```

The docs recommend this route be kept only as a wrkf-backed launch helper.  [oai_citation:9‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_00000000d28071fd91d336096de40c0d)

**Phase 4 — PBC evidence ingestion**

Add:

```text
packages/acp-server/src/wrkf/pbc-evidence.ts
```

Responsibilities:

```text
parse agent output
validate expected evidence schema
call wrkf.evidence.add
finish/fail wrkf run
```

No transition logic yet.

**Phase 5 — Step mode**

Add:

```text
POST /v1/wrkf/pbc/run-step
POST /v1/wrkf/pbc/approve-transition
```

`run-step` launches agent and writes evidence. `approve-transition` applies the wrkf transition with `expectRevision`, `contextHash`, and idempotency.

**Phase 6 — Autopilot**

Add:

```text
POST /v1/wrkf/pbc/run-until-blocked
```

Only apply transitions selected from wrkf `next`, and only under explicit PBC autopilot policy.

**Phase 7 — Effect reconciler**

Replace old ACP effect reconciliation with:

```text
packages/acp-server/src/wrkf/effect-delivery.ts
packages/acp-server/src/integration/wrkf-effect-reconciler.ts
```

The validation plan already calls for tests proving two reconcilers cannot deliver the same effect claim, ack requires matching lease token, and unsupported effects fail non-retryably.  [oai_citation:10‡CANONICAL_WORKFLOW_REFACTOR.md](sediment://file_000000006a50720fbf80a2b314936df0)

## The harness in one sentence

Build an **ACP-hosted wrkf PBC harness** that acts like an HRC/operator cockpit: it reads wrkf state, compiles the next-action prompt, launches/binds HRC runs, writes evidence, applies wrkf transitions only by delegation, and delivers wrkf effects through leases—while wrkf remains the only workflow authority.
