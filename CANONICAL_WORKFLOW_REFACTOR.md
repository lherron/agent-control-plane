# Canonical Workflow Refactor

Updated: 2026-06-05

## Decision

Replace the ACP-owned workflow engine and ledger with **wrkf as the canonical workflow authority**, while keeping ACP as a convenient execution facade for launching and coordinating workflow work through HRC.

This is a direct authority replacement. It is not a deprecation, compatibility, or isolation project. ACP should stop owning workflow truth and rebuild only the useful ACP workflow-facing surfaces as wrappers over the long-term wrkf client substrate.

This proposal now assumes the wrkf client substrate is in place and treats
`../wrkq/docs/wrkf-rpc.md` as the machine contract for wrkf method names, DTO
field names, protocol behavior, and error codes.

- `wrkf rpc --stdio`
- JSON-RPC 2.0 over stdio, framed as NDJSON
- the `@wrkf/client` TypeScript binding
- typed wrkf domain errors
- long-lived wrkf process lifecycle managed by the client
- transition, run, and effect semantics hardened for idempotency, stale revision checks, and effect leases

The earlier shell-out plan using `wrkf --json` is no longer the target ACP architecture. It may remain useful for smoke tests and operator CLI flows, but ACP production workflow surfaces should use the typed TypeScript wrkf client.

Implementation reality as of 2026-06-05:

- `@wrkf/client` lives in `../wrkq/packages/wrkf-client`.
- `WrkfClient.spawn(...)` is synchronous and returns a client; callers then call `initialize(...)`.
- `WrkfClientSpawnOptions` use `clientInfo`, not `client`.
- `effect.retry` uses `{ effectId }` as the canonical param. wrkf also accepts
  `{ id }` as a compatibility fallback, but ACP should not use it.
- `run.fail` input uses `{ runId, summary }`; returned `Run` output exposes
  the stored terminal payload as `terminalResult`.
- `deliveryRef` is currently a string on wrkf runs. If ACP needs structured HRC metadata, encode a stable JSON string or add a wrkf contract change before relying on structure.
- `WRKF_UNAVAILABLE` is not a wrkf domain error. It is an ACP-local transport/process-health mapping for spawn failure, process death, or rejected pending requests.
- Some TS result types are intentionally loose (`Record<string, any>` / extra keys) because v1 is hand-maintained rather than generated from Go DTOs.

Validation already performed for this substrate:

```text
just verify-rpc
go test ./internal/workflow ./internal/wrkfapi ./internal/wrkfrpc ./internal/wrkfcli
```

Post-audit quick-win closeout:

```text
67c9497 fix(wrkf-rpc): align effect retry and run fail contracts
```

Installed-binary smoke reported by clod:

```text
effect.retry {effectId} canonical round-trip
effect.retry {id} compatibility fallback
run.fail summary input -> Run.terminalResult output
full lifecycle CAS/evidence/runs/effects
```

## Current Findings

ACP still contains its own workflow authority stack:

- `packages/acp-core/src/workflow/index.ts`
- `packages/acp-server/src/workflow-runtime.ts`
- `packages/acp-state-store/src/repos/workflow-runtime-repo.ts`
- ACP workflow route handlers for task creation, workflow publishing, transitions, evidence, obligations, participant runs, supervisor runs, effects, patch proposals, context compilation, and control actions

ACP jobs and scheduler should remain separate from workflow authority:

- scheduled jobs dispatch through `/v1/inputs`
- flow job agent steps dispatch through `/v1/inputs`
- the scheduler should not import workflow transition logic
- workflow-aware job behavior should be explicit job step behavior over wrkf-backed ACP services

wrkf owns the canonical workflow substrate:

- workflow templates
- workflow instances
- workflow revisions
- workflow event ledger
- workflow transitions
- evidence
- obligations
- effects
- workflow runs
- idempotency
- stale revision and context checks

## Target Boundary

wrkf owns workflow truth.

ACP owns execution convenience.

### wrkf owns

- workflow templates
- workflow instances
- workflow revisions
- state transitions
- evidence
- obligations
- effects
- runs
- workflow event ledger
- idempotency and stale revision checks
- effect status and effect leases
- external run binding metadata where it defines workflow execution truth

### ACP owns

- HTTP and CLI facade for operators, dashboards, and gateways
- HRC session launch
- role/session binding convenience for execution
- workflow participant launch prompts
- delivery of leased wrkf effects into ACP/HRC/coordination substrates
- job-triggered workflow execution convenience
- dashboard-friendly projections, if needed
- execution telemetry and dispatch fencing, where explicitly non-canonical

ACP must not persist alternate workflow state. Any ACP persistence related to workflows must be execution metadata only and must not be required to reconstruct workflow truth.

## Invariants

- wrkf is the only writer of canonical workflow state.
- ACP never computes legal workflow transitions independently.
- ACP never stores a parallel workflow ledger.
- ACP does not publish or validate workflow definitions with ACP-specific rules.
- ACP routes that expose workflow data read it from wrkf.
- ACP routes that mutate workflow data delegate the mutation to wrkf.
- HRC launches are execution side effects, not workflow state transitions.
- Effect delivery is idempotent and reconcilable against wrkf effect status.
- ACP never spawns wrkf per workflow request.
- ACP route handlers never know JSON-RPC frame shape.
- ACP never parses wrkf stderr or human CLI output.
- ACP maps typed wrkf errors to HTTP errors.
- ACP never stores wrkf projections as durable truth.
- HRC launch correlation is bound back to wrkf runs through `wrkf.run.bindExternal`.
- Effect delivery is protected by wrkf leases, not ACP-local pending rows.

## Proposed Architecture

```text
operator / UI / gateway / scheduler
                |
                v
          ACP HTTP / CLI
  --------------------------------
  auth, request validation,
  HRC launch, coordination delivery,
  prompt construction, dashboard views,
  job-triggered execution
  --------------------------------
                |
                v
        AcpWrkfWorkflowPort
  thin ACP-local adapter:
  error mapping, DTO shaping,
  launch-context helpers
                |
                v
          @wrkf/client
  JSON-RPC 2.0 over stdio,
  process lifecycle, typed methods
                |
                v
        wrkf rpc --stdio
                |
                v
          workflow.Service
                |
                v
            wrkq DB
```

The important boundary is not merely “ACP calls wrkf.” The important boundary is that ACP contains no workflow state machine, no workflow ledger, no transition legality, no effect truth, and no durable workflow facts.

`@wrkf/client` is the wrkf application boundary. `AcpWrkfWorkflowPort` is a thin ACP-facing port that hides package lifecycle and response-shaping details, not a semantic layer that re-implements workflow behavior.

## Required wrkf Client Capabilities

ACP assumes the TypeScript wrkf client exposes, at minimum:

```text
workflow.validate
workflow.install
workflow.show
workflow.list
workflow.diff

task.attach
task.inspect
task.timeline
task.refresh
task.syncMeta

next

evidence.add
evidence.list
evidence.show
evidence.suggest

obligation.list
obligation.show
obligation.satisfy
obligation.waive
obligation.cancel

transition.apply

run.start
run.bindExternal
run.finish
run.fail
run.show
run.list

effect.claim
effect.show
effect.ack
effect.fail
effect.retry
effect.list
```

The implemented v1 client also exposes `check.*`, `hook.*`, and `effect.deliver`.
ACP should not put those in the first workflow facade port unless a retained ACP
surface actually needs them.

Required correctness semantics:

```text
atomic transition compare-and-set
typed stale revision/context mismatch errors
idempotent run.start
idempotent terminal run.finish/run.fail
run.bindExternal for HRC run/session/runtime references
effect claim leases with lease tokens
effect ack/fail requiring matching lease token
stable JSON-RPC error codes
```

Without these semantics, ACP can call wrkf but cannot reliably survive crashes and duplicate execution at the wrkf/HRC boundary.

## ACP wrkf Integration

Add `@wrkf/client` to `packages/acp-server/package.json`.

Add a narrow ACP-local port:

```ts
// packages/acp-server/src/wrkf/port.ts
import type { WrkfClient } from '@wrkf/client'

export type AcpWrkfWorkflowPort = Pick<
  WrkfClient,
  | 'workflow'
  | 'task'
  | 'next'
  | 'evidence'
  | 'obligation'
  | 'transition'
  | 'run'
  | 'effect'
>
```

Wire it into ACP server dependencies:

```ts
export interface AcpServerDeps {
  // existing deps...
  wrkf?: AcpWrkfWorkflowPort | undefined
}

export interface ResolvedAcpServerDeps extends AcpServerDeps {
  // existing resolved deps...
  wrkf: AcpWrkfWorkflowPort
}
```

Production wiring should create one supervised long-lived RPC client when ACP starts:

```ts
const wrkf = WrkfClient.spawn({
  command: process.env.WRKF_BIN ?? 'wrkf',
  dbPath: process.env.WRKF_DB_PATH,
  clientInfo: { name: 'acp-server', version: ACP_VERSION },
})
await wrkf.initialize()
```

Route handlers receive `deps.wrkf`. They must never spawn wrkf, shell out, parse CLI output, or know the JSON-RPC frame format.

ACP should fail startup if wrkf initialization fails unless an explicit local-dev/test mode supplies a fake or disabled client. Serving workflow routes without canonical wrkf authority should be a fail-closed condition.

## wrkf Error Mapping

Create:

```text
packages/acp-server/src/wrkf/errors.ts
```

Map typed wrkf errors to HTTP consistently:

| wrkf error | HTTP |
| --- | --- |
| `WRKF_NOT_FOUND` | 404 |
| `WRKF_ROLE_DENIED` | 403 |
| `WRKF_STALE_REVISION` | 409 |
| `WRKF_CONTEXT_MISMATCH` | 409 |
| `WRKF_IDEMPOTENCY_MISMATCH` | 409 |
| `WRKF_LEASE_CONFLICT` | 409 |
| `WRKF_TRANSITION_BLOCKED` | 422 |
| `WRKF_VALIDATION` | 422 |
| `WRKF_EFFECT_NOT_DELIVERABLE` | 422 |
| `WRKF_DB_MIGRATION_REQUIRED` | 503 |
| `WRKF_INTERNAL` | 500 |

Do not collapse stale revision, idempotency conflict, and lease conflict into generic validation failures. They are concurrency conflicts.

ACP should also synthesize an ACP-local `WRKF_UNAVAILABLE`-class HTTP 503 when
the wrkf process cannot be spawned, exits while requests are pending, corrupts
stdout, or rejects transport-level calls. This is not a wrkf domain `data.code`
today.

## ACP Surface To Keep

Keep workflow-oriented ACP surfaces only where they provide execution value over raw wrkf.

### `POST /v1/workflow-participant-runs`

Keep and rebuild as the main HRC launch convenience route.

Target sequence:

```text
parse request
  -> deps.wrkf.task.inspect({ task })
  -> deps.wrkf.next({ task, role? })
  -> deps.wrkf.run.start({
       task,
       role,
       actor,
       idempotencyKey
     })
  -> if wrkf run already has externalRunRef:
       return replay result
  -> create ACP execution run record if needed for HRC dispatch fencing
  -> build HRC launch prompt from wrkf run/task/next projection
  -> launch HRC runtime through launchRoleScopedRun
  -> deps.wrkf.run.bindExternal({
       runId: wrkfRun.id,
       externalRunRef: launched.runId,
       deliveryRef: stableJson({
         kind: 'hrc',
         hostSessionId,
         runtimeId,
         launchId,
         scopeRef,
         laneRef,
         generation
       }),
       idempotencyKey: `${idempotencyKey}:bindExternal`
     })
  -> return wrkf run + HRC launch descriptor
```

Preferred request shape:

```ts
type CreateWorkflowParticipantRunRequest = {
  taskId: string
  role: string
  actor?: { kind: 'agent' | 'human' | 'service'; id: string }
  idempotencyKey: string
  sessionRef?: { scopeRef: string; laneRef?: string }
  launchRuntime?: boolean
  initialPrompt?: string
}
```

Preferred response shape:

```ts
type CreateWorkflowParticipantRunResponse = {
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

Do not return ACP participant-run objects. The wrkf run is the run.

Current wrkf implementation note: `run.deliveryRef` is a string. ACP may encode
structured HRC delivery metadata as compact JSON, but must treat that encoding
as ACP-owned unless wrkf grows a structured delivery reference DTO.

Crash handling:

```text
crash after wrkf.run.start, before HRC launch:
  retry same idempotency key -> same wrkf run; no externalRunRef; launch then bind.

crash after HRC launch, before bindExternal:
  retry same idempotency key -> same wrkf run; ACP should try to discover existing HRC run by deterministic ACP/HRC correlation if available; otherwise relaunch is possible, but bindExternal must reject conflicting external refs.

crash after bindExternal:
  retry same idempotency key -> same wrkf run with externalRunRef; return replay.
```

The remaining weak point is HRC launch idempotency. Use ACP `runStore` dispatch fencing with a deterministic ACP run id or metadata key derived from `wrkfRun.id` where possible. If `runStore.createRun` cannot accept deterministic IDs today, either add that capability or accept that retry after post-HRC/pre-bind crash may relaunch.

### `POST /v1/workflow-participant-runs/:runId/complete`

Keep, but make `runId` a wrkf run id.

Implementation:

```text
deps.wrkf.run.finish({
  runId,
  status: 'completed',
  summary
})
```

This route should not apply a workflow transition implicitly. Completion of execution and transition of workflow state are separate actions unless wrkf intentionally introduces a combined method.

Current wrkf implementation note: terminal replay/conflict is keyed by the
stored terminal status and summary. There is no `idempotencyKey`, `outcome`, or
`evidenceRefs` parameter on `run.finish` today. The returned `Run` serializes
the stored summary as `terminalResult`, not `summary`.

### `POST /v1/workflow-participant-runs/:runId/fail`

Keep, but make `runId` a wrkf run id.

Implementation:

```text
deps.wrkf.run.fail({
  runId,
  summary: failureSummary
})
```

Repeated failure with the same terminal payload should replay. Conflicting terminal payload should map to `409`.

Current wrkf implementation note: `run.fail` accepts `summary`. ACP should fold
`reason`, `classification`, and operator-facing failure detail into that summary
until wrkf exposes a richer terminal payload. The returned `Run` serializes the
stored summary as `terminalResult`, not `summary`.

### `POST /v1/workflow-interact-runs`

Keep as an interactive HRC bootstrap route, but avoid hidden workflow mutation.

Target behavior:

```text
if taskId provided:
  inspect task through wrkf
  fetch next actions
  build initial prompt if one was not explicitly supplied

start/reuse HRC runtime
inject WRKF_* env vars
return attach descriptor
```

Preferred environment variables:

```text
WRKF_TASK_ID
WRKF_INSTANCE_ID
WRKF_RUN_ID        only if a run is explicitly supplied/started
WRKF_WORKFLOW_REF
WRKF_ROLE          if supplied
WRKF_ACTOR         if supplied
WRKF_CONTEXT_HASH
```

Avoid long-term `ACP_WORKFLOW_*` variables. They may remain as temporary compatibility aliases for one release if existing harnesses still read them.

### `GET /v1/tasks/:taskId`

Keep only as a dashboard/gateway projection over wrkf.

Implementation should compose:

```text
deps.wrkf.task.inspect({ task })
deps.wrkf.task.timeline({ task })
deps.wrkf.next({ task })
deps.wrkf.evidence.list({ task })
deps.wrkf.obligation.list({ task })
deps.wrkf.effect.list({ task })
deps.wrkf.run.list({ task })
```

Response should be explicitly source-tagged:

```ts
{
  source: 'wrkf',
  task: ...,
  instance: ...,
  next: ...,
  timeline: ...,
  evidence: ...,
  obligations: ...,
  effects: ...,
  runs: ...
}
```

Remove ACP-only fields:

```text
supervisorRuns
participantRuns
workflowHrcRunMaps
anomalies
workflowPatchProposals
ACP task version
ACP workflow hash
ACP context hashes
```

If route compatibility matters for UI, retain `/v1/tasks/:taskId`. Otherwise prefer introducing `/v1/wrkf/tasks/:taskId` and making the old route a thin alias.

### `POST /v1/tasks/:taskId/evidence`

Keep as a convenience route.

Implementation:

```text
deps.wrkf.evidence.add({
  task,
  kind,
  ref,
  summary,
  facts,
  actor,
  role
})
```

Current wrkf implementation note: `evidence.add` does not accept
`expectRevision`, `idempotencyKey`, or `runId` today. ACP must not silently
pretend `expectedTaskVersion` is enforced. If a retained consumer requires
evidence-level CAS or idempotency, that is a wrkq/wrkf contract change.

For legacy ACP requests, reject or explicitly ignore `expectedTaskVersion` with
a compatibility warning; do not translate it to a non-existent wrkf precondition.

Obsolete field rename from the pre-implementation sketch:

```text
expectedTaskVersion -> expectRevision
```

### `POST /v1/tasks/:taskId/transitions`

Keep as a convenience route.

Implementation:

```text
deps.wrkf.transition.apply({
  task,
  transition,
  role,
  actor,
  expectRevision,
  contextHash,
  idempotencyKey,
  checkIds,
  runChecks,
  dryRun
})
```

After success, do not call the old ACP effect reconciler. Instead enqueue or run a wrkf effect delivery tick against wrkf leases.

Current wrkf implementation note: `transition.apply` does not accept
`evidenceRefs`, `waiverRefs`, `inlineEvidence`, or `runId`. Evidence and
obligation mutations are separate wrkf calls before transition application.

### Obligation Routes

Keep if there is a UI/gateway consumer:

```text
POST /v1/tasks/:taskId/obligations/:obligationId/waive
POST /v1/tasks/:taskId/obligations/:obligationId/cancel
```

Implementation:

```text
deps.wrkf.obligation.waive(...)
deps.wrkf.obligation.cancel(...)
```

Do not pre-check existence through an ACP obligation list. Let wrkf return the
authoritative status/error. Current wrkf obligation status calls accept `task`,
`id`, `evidenceId`, and `reason`; they do not currently carry idempotency,
actor, or role parameters.

### `POST /v1/workflows`

Default recommendation: remove from ACP.

If retained for a UI/gateway, it must be a pure wrkf facade:

```text
deps.wrkf.workflow.validate(...)
deps.wrkf.workflow.install(...)
```

No ACP validation. No ACP built-in publication. No ACP workflow definition storage.

## ACP Surface To Remove

Remove surfaces that exist only because ACP was acting as a workflow authority:

```text
POST /v1/tasks
POST /v1/workflow-supervisor-runs
POST /v1/tasks/:taskId/actions
POST /v1/tasks/:taskId/participant-context
POST /v1/tasks/:taskId/supervisor-context
GET  /v1/tasks/:taskId/workflow-patch-proposals
GET  /v1/workflow-patch-proposals/:proposalId
```

Rationale:

```text
POST /v1/tasks:
  ACP workflow task creation becomes wrkq task creation plus wrkf.task.attach.
  Do not keep a route whose name implies ACP creates canonical workflow tasks.

workflow-supervisor-runs / actions:
  These encode ACP supervisor-control semantics. Remodel through wrkf runs, effects,
  next actions, and transitions if still needed.

participant-context / supervisor-context:
  These compile ACP-kernel context. Replace with launch prompt construction from
  wrkf task/run/next projections.

patch proposals:
  Remove unless wrkf grows canonical patch proposal support.
```

If a route is useful, rebuild it against wrkf rather than keeping it as a compatibility shim.

## Effect Delivery Redesign

Replace:

```text
packages/acp-server/src/integration/workflow-effect-reconciler.ts
```

with:

```text
packages/acp-server/src/integration/wrkf-effect-reconciler.ts
```

New protocol:

```text
claim effects from wrkf
  -> deliver each leased effect into ACP/HRC/coordination
  -> ack or fail through wrkf using lease token
```

Skeleton:

```ts
export async function reconcileWrkfEffects(input: {
  wrkf: AcpWrkfWorkflowPort
  coordStore: CoordinationStore
  launchRoleScopedRun?: LaunchRoleScopedRun
  runStore?: RunStore
  limit?: number
}): Promise<WrkfEffectReconcileResult> {
  const claimed = await input.wrkf.effect.claim({
    adapter: 'acp',
    limit: input.limit ?? 100,
    leaseMs: 60_000,
  })

  for (const effect of claimed.effects) {
    try {
      const receipt = await deliverWrkfEffect(input, effect)
      await input.wrkf.effect.ack({
        effectId: effect.id,
        leaseToken: claimed.leaseToken,
        receipt,
      })
    } catch (error) {
      await input.wrkf.effect.fail({
        effectId: effect.id,
        leaseToken: claimed.leaseToken,
        reason: error instanceof Error ? error.message : String(error),
        retryable: isRetryableEffectDeliveryError(error),
      })
    }
  }
}
```

Current wrkf implementation note: `effect.claim` returns one lease token for the
claim batch (`{ effects, leaseToken, leaseExpiresAt }`). Each `ack`/`fail` call
uses the claimed effect id plus that shared lease token.

Effect adapters:

```text
declare_handoff:
  append coordination handoff.declared with idempotencyKey = effect.idempotencyKey;
  ack with coordination event/handoff receipt.

wake_role_session:
  append attention.requested / wake command with idempotencyKey = effect.idempotencyKey;
  optionally route into existing wake dispatcher;
  ack with coordination receipt.

launch_participant_run, if wrkf adds it:
  call the same participant-launch service used by POST /v1/workflow-participant-runs;
  bind HRC run through wrkf.run.bindExternal;
  ack with wrkfRunId + hrcRunId.

unsupported effect:
  fail with retryable=false and code unsupported_effect_kind.
```

ACP does not have its own pending effect rows. wrkf owns effect status and leasing. ACP owns only delivery adapter code.

## Data Model Changes

Remove from ACP canonical state:

- workflow definitions
- workflow tasks
- workflow events
- workflow evidence
- workflow obligations
- workflow effect intents
- workflow participant runs
- workflow supervisor runs
- workflow anomalies
- workflow patch proposals
- workflow idempotency records
- workflow context hashes
- workflow runtime metadata

Prefer not adding new workflow tables.

Use wrkf for:

- wrkf run to HRC external run references
- wrkf run delivery references as strings; ACP may store compact JSON strings for host session, runtime, launch, scope, lane, and generation until wrkf grows a structured delivery reference
- wrkf effect status
- wrkf effect leases
- wrkf effect receipts

Use ACP `runStore` only as execution telemetry/fencing for HRC dispatch, not as workflow truth. A stored ACP run may contain:

```ts
metadata: {
  source: 'wrkf',
  wrkfTaskId,
  wrkfInstanceId,
  wrkfRunId,
  workflowRef,
  role
}
```

If an ops dashboard later needs durable delivery-attempt history beyond wrkf receipts, add a clearly non-authoritative table named around attempts, not workflow state:

```sql
wrkf_effect_delivery_attempts (
  id text primary key,
  wrkf_effect_id text not null,
  wrkf_lease_token text,
  adapter text not null,
  status text not null,
  receipt_json text,
  error_json text,
  started_at text not null,
  finished_at text
)
```

Do not add this table in the first cut unless there is an immediate observability need.

## Known wrkq/wrkf Contract Follow-ups

These are not reasons to keep ACP workflow authority. They are wrkf contract
items ACP must either avoid or handle conservatively until fixed upstream:

- `run.deliveryRef` is a string. If structured HRC delivery metadata is a
  durable wrkf contract, add a structured DTO in wrkq/wrkf rather than relying
  forever on ACP-owned JSON encoding.
- `evidence.add` has no CAS, idempotency key, or run binding parameter. If ACP
  needs those semantics, add them to wrkq/wrkf before exposing them in ACP.
- obligation status calls have no idempotency, actor, or role parameters today.
  If ACP needs auditable/role-gated obligation lifecycle actions, add that to
  wrkq/wrkf before promising it through ACP.
- wrkf exposes stable error codes, but detailed stale revision/context payloads
  may be lossy in current normalization. ACP should key behavior on
  `WrkfRpcError.code`, not on detailed payload fields, until wrkq/wrkf preserves
  those details end to end.

## Jobs And Scheduler

Keep prompt-style jobs unchanged.

New optional workflow job behavior should be explicit:

```ts
type WorkflowJobStep =
  | {
      kind: 'wrkf.participantRun.start'
      taskId: string
      role: string
      actor?: Actor
      launchRuntime?: boolean
    }
  | {
      kind: 'wrkf.transition.apply'
      taskId: string
      transitionId: string
      role: string
      expectRevision: number
      contextHash?: string
    }
  | {
      kind: 'wrkf.task.inspect'
      taskId: string
    }
  | {
      kind: 'wrkf.effects.deliverTick'
      limit?: number
    }
```

Scheduler rule:

```text
jobs may trigger wrkf operations through the same ACP service layer used by routes;
jobs may not inspect templates, evaluate guards, compute legal transitions, or mutate workflow tables.
```

## Implementation Plan

### Phase 0 — wrkf client contract gate

Before touching ACP route behavior, verify the wrkf client features ACP needs
against the installed binary and real `wrkf rpc --stdio`:

- `@wrkf/client` package available to ACP
- `WrkfClient.spawn` and `close` lifecycle
- `task.inspect`, `next`, and `timeline`
- `transition.apply` with `expectRevision`, `contextHash`, and `idempotencyKey`
- `run.start` idempotency
- `run.bindExternal`
- `run.finish` and `run.fail` idempotency
- `effect.claim` with lease token
- `effect.ack` and `effect.fail` with lease token
- typed `WrkfRpcError` codes

Existing wrkf-side gate:

```text
just verify-rpc
go test ./internal/workflow ./internal/wrkfapi ./internal/wrkfrpc ./internal/wrkfcli
```

ACP deliverable: one ACP-side fake client test and one real-process startup
smoke proving ACP can initialize `@wrkf/client` through production lifecycle
wiring.

### Phase 1 — Add ACP wrkf port and lifecycle

Add:

```text
packages/acp-server/src/wrkf/port.ts
packages/acp-server/src/wrkf/errors.ts
packages/acp-server/src/wrkf/launch-context.ts
packages/acp-server/src/wrkf/effect-delivery.ts
packages/acp-server/src/wrkf/client-lifecycle.ts
```

Change:

```text
packages/acp-server/src/deps.ts
packages/acp-server/src/cli.ts
packages/acp-server/src/create-acp-server.ts
```

`cli.ts` should initialize the wrkf RPC client once and close it on shutdown. Tests should inject fakes through `deps.wrkf`.

### Phase 2 — Rebuild read facade first

Replace `handleGetWorkflowTask` with wrkf reads.

No mutations, no HRC launch, no effect reconciliation.

Tests:

```text
GET /v1/tasks/:taskId returns source='wrkf'
GET missing task maps WRKF_NOT_FOUND -> 404
handler does not import workflow-runtime
```

### Phase 3 — Rebuild mutation facades

Replace:

```text
handleAttachWorkflowEvidence
handleApplyWorkflowTransition
handleWaiveWorkflowObligation
handleCancelWorkflowObligation
```

with wrkf calls.

Tests:

```text
transition expectedTaskVersion compatibility alias maps to expectRevision, if retained
WRKF_STALE_REVISION -> 409
WRKF_CONTEXT_MISMATCH -> 409
WRKF_ROLE_DENIED -> 403
WRKF_IDEMPOTENCY_MISMATCH -> 409
successful transition optionally triggers wrkf effect delivery tick
```

Do not call the old ACP effect reconciler.

### Phase 4 — Rebuild participant launch

Refactor participant launch into a reusable service:

```text
packages/acp-server/src/wrkf/participant-launch.ts
```

Routes and jobs should call this service rather than duplicating the run/HRC/bind sequence.

Service responsibilities:

```text
start or replay wrkf run
construct deterministic sessionRef if missing
create ACP runStore record only for HRC dispatch telemetry/fencing
build launch prompt from wrkf projection
launch HRC
bind external HRC ref back to wrkf run
return source-tagged result
```

Tests should cover split failures:

```text
run.start succeeds, HRC launch fails
HRC launch succeeds, bindExternal fails
retry same idempotency key after run.start
retry same idempotency key after bindExternal
terminal wrkf run rejects launch
```

### Phase 5 — Replace effect reconciler

Delete old ACP-state reconciler usage and introduce wrkf lease reconciler.

Change all post-mutation calls from:

```ts
reconcileWorkflowEffectIntents(...)
```

to either:

```ts
reconcileWrkfEffects(...)
```

or enqueue a tick, depending on existing ACP loop conventions.

Tests:

```text
two reconcilers cannot deliver same effect claim
ack requires matching lease token
fail marks retryable/non-retryable correctly
declare_handoff appends coordination event idempotently
wake_role_session appends wake/attention idempotently
unsupported kind fails non-retryably
```

### Phase 6 — Remove obsolete routes

Remove route registrations and handler files for ACP-only workflow authority:

```text
handleCreateWorkflowTask
handleStartWorkflowSupervisorRun
handleWorkflowControlAction
handleWorkflowParticipantContext
handleWorkflowSupervisorContext
handleListWorkflowPatchProposals
handleShowWorkflowPatchProposal
handlePublishWorkflow unless retained as wrkf install facade
```

Update `mutating-routes.ts` if it contains specs for removed routes.

### Phase 7 — Remove ACP workflow kernel/state

Remove production exports and imports:

```text
packages/acp-server/src/workflow-runtime.ts
packages/acp-core/src/workflow/*
packages/acp-state-store/src/repos/workflow-runtime-repo.ts
```

Update package descriptions if needed. `acp-core` should stop describing itself as workflow domain authority. It can retain generic ACP types, presets, input/run types, and task-context helpers if still used outside the obsolete workflow kernel.

Remove root conformance invocation:

```text
bun test tests/conformance/acp-workflow
```

Replace with:

```text
bun test tests/conformance/acp-wrkf-facade
```

or package-local ACP server tests.

### Phase 8 — Boundary enforcement

Extend `scripts/check-boundaries.ts`.

Suggested check names:

```text
ACP workflow authority removal:
  forbid withDurableWorkflowKernel
  forbid createInMemoryWorkflowKernel
  forbid WorkflowRuntimeRepo
  forbid stateStore.workflowRuntime
  forbid acp-core/src/workflow production imports

ACP wrkf dependency direction:
  ACP may import @wrkf/client
  @wrkf/client must not import ACP/HRC packages
  jobs may import ACP wrkf service layer, not wrkf internals
```

Completion criterion:

```text
rg "withDurableWorkflowKernel|createInMemoryWorkflowKernel|workflowRuntime|WorkflowRuntimeRepo" packages
```

returns no production hits.

## Route Mapping Sketch

| Existing ACP Concept | Target |
| --- | --- |
| Publish workflow definition | remove by default, or pure `wrkf.workflow.validate/install` facade |
| Create workflow task | `wrkq touch` plus `wrkf.task.attach`; do not keep ACP workflow task creation |
| Show workflow task | wrkf projection facade over `task.inspect`, `next`, timeline, evidence, obligations, effects, runs |
| Apply transition | `wrkf.transition.apply` with `expectRevision`, `contextHash`, and idempotency |
| Attach evidence | `wrkf.evidence.add` |
| List obligations | `wrkf.obligation.list` |
| Waive/cancel obligation | `wrkf.obligation.waive/cancel` |
| List effects | `wrkf.effect.list` |
| Deliver effect | ACP effect adapter over `wrkf.effect.claim/ack/fail` leases |
| Start participant run | `wrkf.run.start` plus HRC launch plus `wrkf.run.bindExternal` |
| Complete participant run | `wrkf.run.finish` |
| Fail participant run | `wrkf.run.fail` |
| Supervisor actions | remove or remodel as wrkf next/effect/run operations |
| Patch proposals | remove unless wrkf grows canonical patch proposal support |

## Rejected Alternatives

### Keep an ACP `WrkfClient` command-wrapper abstraction

This was useful only when wrkf had no stable TS client. Once `@wrkf/client` exists, a command-wrapper layer preserves the wrong operational model: per-call process spawning, stderr risk, and CLI-shaped DTOs.

### Let every route call `@wrkf/client` directly

This is locally simple but scatters error mapping, launch context construction, and response shaping across handlers. Use an ACP-local port/service layer, but keep it thin and non-authoritative.

### Preserve ACP workflow response shape exactly

The old response shape encodes ACP concepts: participant runs, supervisor runs, patch proposals, ACP task versions, ACP context hashes, and effect intents. Keeping that shape would pressure the implementation to recreate a shadow ledger. Retained routes should return source-tagged wrkf projections.

### Store wrkf/HRC mappings primarily in ACP

With `run.bindExternal`, wrkf can hold canonical execution binding. ACP `runStore` is still useful for HRC dispatch fencing and local observability, but it should not be required to reconstruct workflow execution truth.

## Adversarial Audit

### wrkf RPC process dies

ACP should fail in-flight wrkf calls with `503 WRKF_UNAVAILABLE`, mark health degraded, and restart the client for later requests. It should not fall back to ACP workflow state.

### stale UI revision

A transition with stale `expectRevision` maps to `409`. ACP should not retry
automatically because the user/operator must inspect changed state. Today ACP
should not require detailed actual revision/context fields to be present; rely
on the wrkf error code first.

### duplicate participant launch request

Same idempotency key returns the same wrkf run. If `externalRunRef` is already bound, ACP returns replay. If not bound, ACP proceeds to launch/bind.

### two ACP instances deliver effects

Only one instance can claim a wrkf effect lease. The loser receives no claim or `WRKF_LEASE_CONFLICT`. Coordination delivery should also use effect idempotency keys.

### route name implies ACP authority

Every retained workflow response includes `source: "wrkf"`. New docs should call ACP a facade, not a workflow runtime.

### old tables still exist

Old SQLite tables may remain on disk during migration, but no production code may read or write them. Drop/archive later as a separate data-retention decision.

## Validation Plan

Automated checks:

```text
bun run build
bun run typecheck
bun run test
bun run check:boundaries

@wrkf/client fake-transport tests
@wrkf/client real wrkf rpc --stdio tests
ACP wrkf port fake-client tests
ACP retained route facade tests
ACP participant launch split-failure tests
ACP wrkf effect reconciler lease tests
wrkq wrkf RPC smoke test
installed ACP/HRC/wrkq smoke test
```

Manual smoke checks with installed binaries:

```text
start wrkf rpc through ACP startup
create/select wrkq task
attach wrkf workflow
GET /v1/tasks/:taskId returns wrkf projection
POST /v1/workflow-participant-runs starts wrkf run and HRC runtime
verify wrkf run externalRunRef contains the HRC run id
verify HRC delivery metadata is recoverable from wrkf run deliveryRef string, if ACP encoded it there
POST /v1/tasks/:taskId/evidence writes to wrkf
POST /v1/tasks/:taskId/transitions changes wrkf revision/state
trigger wrkf effect and verify ACP claims/acks/fails through wrkf
verify scheduler /v1/inputs path still works
verify old ACP workflow tables receive no writes
verify boundary check rejects any reintroduced ACP workflow kernel import
```

Do not report the refactor complete until installed binaries have been smoke tested against real local ACP/HRC/wrkq configuration.

## Risks

- wrkf RPC process lifecycle must be handled explicitly: startup, shutdown, restart, health, and in-flight request failure.
- `@wrkf/client` becomes an application contract, so its DTOs and error codes need compatibility discipline.
- HRC launch remains a split transaction with wrkf run state; idempotency and `run.bindExternal` reduce but do not magically eliminate launch duplication risks.
- Some existing ACP workflow tests assert obsolete behavior and should be deleted rather than mechanically rewritten.
- Existing ACP workflow route names may imply ACP authority; retained names should clearly identify wrkf as the source of truth.
- Effect delivery must use wrkf leases. A list-then-deliver loop is not safe under multiple ACP processes.
- Old ACP workflow tables may remain physically present during migration; boundary checks must ensure they are not used.

## Open Questions

- Should ACP retain `/v1/workflows` as a `wrkf.workflow.validate/install` facade, or should template installation remain wrkf-only?
- Should ACP introduce `/v1/wrkf/tasks/:taskId` and make `/v1/tasks/:taskId` a compatibility alias, or keep the existing route name with `source: "wrkf"`?
- Can ACP `runStore` support deterministic run IDs or deterministic launch-correlation metadata derived from `wrkfRun.id`?
- Which current UI/gateway consumers require old workflow response fields, and can those consumers move to wrkf projection fields directly?
- Should effect delivery attempts be stored only in wrkf receipts, or should ACP add a non-authoritative `wrkf_effect_delivery_attempts` table for operator observability?

## Completion Criterion

ACP can be restarted with no ACP workflow tables at all, and every retained workflow surface still works because wrkf is the only workflow authority.
