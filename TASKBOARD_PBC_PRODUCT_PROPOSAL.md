# Taskboard proposal: PBC product experience backed by ACP

## Decision

Taskboard should implement the **user-facing PBC experience** and delegate workflow execution to ACP’s PBC product facade. The browser and Taskboard should not call raw wrkf transitions, raw `ParticipantOutput`, wrkf context hashes, or low-level PBC harness debug routes.

Taskboard owns:

```text
visible wrkq task creation
PBC intake UX
PBC task detail page
clarification form
patch-decision form
final/disposed artifact display
job polling and retry affordances
operator diagnostics panel
```

ACP owns:

```text
PBC workflow attach/start
PBC evidence and obligation writes
PBC agent worker
HRC launch/output parsing
wrkf transition application
effect delivery
PBC projection
```

Primary flow:

```text
Browser
  -> Taskboard /admin/pbc/intakes
    -> wrkqd /v1/tasks/create          # visible task
    -> ACP /v1/pbc/tasks/:taskId/start # attach workflow + seed intake + continue
      -> wrkf + HRC

Browser
  -> Taskboard /admin/pbc/tasks/:taskId
    -> ACP /v1/pbc/tasks/:taskId       # PBC projection
    -> wrkqd task detail, when workspace/project context is available
```

---

## Pressure test against the actual Taskboard implementation

### What already exists

Taskboard’s API server already has `acpUrl` configuration and reports it from `/admin/status`, but it does not otherwise call ACP.

Taskboard already has a good visible task creation path. `POST /admin/tasks/:project/containers/:containerId/tasks` resolves the container, calls wrkqd `/v1/tasks/create`, then returns task detail. PBC intake should reuse this path rather than creating hidden ACP-only tasks.

The web client already exposes `createTask(workspaceId, containerId, data)` and has established request/response validation patterns in `apps/web/src/api/client.ts` and shared zod schemas.

The app router has normal route registration in `apps/web/src/routes.tsx`; there are no PBC routes today.

Taskboard already has a wrkq webhook SSE endpoint at `/api/webhooks/stream`, but PBC does not need SSE for the first implementation. Polling `/admin/pbc/jobs/:jobId` is simpler and enough.

### Actual gaps

There is no ACP HTTP client helper in `apps/api/src/server.js`. Add one beside the wrkqd client, with consistent error normalization and actor/header forwarding.

There are no `/admin/pbc/*` routes.

There are no shared PBC schemas in `packages/shared/src/schema`.

There are no web client functions for PBC.

There are no PBC pages or components.

True exactly-once intake cannot be achieved with the current Taskboard-only path unless Taskboard adds durable intake idempotency or wrkqd task creation gains idempotency. ACP can make workflow start idempotent after a task exists, but it cannot dedupe duplicate visible tasks created by Taskboard before ACP is called. This should be fixed with a small Taskboard intake idempotency store or an equivalent wrkqd idempotency key.

---

## Product routes in Taskboard API

Add these routes to `apps/api/src/server.js`:

```text
POST /admin/pbc/intakes
GET  /admin/pbc/tasks/:taskId
POST /admin/pbc/tasks/:taskId/input
POST /admin/pbc/tasks/:taskId/continue
POST /admin/pbc/tasks/:taskId/dispose
GET  /admin/pbc/jobs/:jobId
```

These routes proxy ACP product APIs and, where needed, combine ACP PBC projection with wrkq task detail.

Do not expose ACP’s low-level `/v1/wrkf/pbc/*` debug routes in Taskboard.

---

## Server-side ACP client

Add a small ACP client helper modeled after the existing wrkqd client.

```js
function makeAcpClient({ baseUrl, token }) {
  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || `ACP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  return { request };
}
```

Actor handling should be consistent with the current wrkqd actor behavior. If Taskboard uses an `X-Wrkq-Actor` or authenticated user identity, forward the equivalent actor to ACP through the agreed header/body convention. Product-owner actions must be tied to the authenticated user, not arbitrary browser-supplied actor strings.

---

## Intake idempotency

### Why this matters

The intended PBC intake creates a visible wrkq task before ACP starts the PBC workflow. If the network fails after task creation but before the browser receives the response, a retry can create a duplicate visible task unless Taskboard or wrkqd stores an idempotency record.

ACP start idempotency does not solve duplicate task creation because ACP only sees the task after Taskboard creates it.

### Recommended implementation

Add a small durable Taskboard `PbcIntakeStore` keyed by `clientRequestId` / `idempotencyKey`.

```text
pbc_intake_requests
  idempotency_key
  actor_hash
  body_hash
  status              -- creating_task | starting_workflow | succeeded | failed
  workspace_id
  container_id
  task_id
  acp_job_id
  response_json
  error_json
  created_at
  updated_at
```

Behavior:

```text
fresh key:
  create record, create wrkq task, persist task_id, call ACP start, persist response.

same key + same body:
  replay stored response or resume from recorded task_id.

same key + different body:
  return 409 idempotency_conflict.

crash after task creation before ACP start:
  retry finds task_id and resumes ACP start.

crash after ACP start before response:
  retry replays or refetches ACP projection/job.
```

If Taskboard cannot add a durable store in the first cut, document duplicate-task risk explicitly and require the browser to preserve `clientRequestId` across retries. That is acceptable only as a temporary local/dev behavior.

---

## `POST /admin/pbc/intakes`

Request:

```ts
type CreatePbcIntakeRequest = {
  idempotencyKey: string;
  workspaceId: string;
  containerId: string;
  title: string;
  rawFeedback: string;
  source?: string;
  context?: string;
  priority?: string;
  labels?: string[];
  autoContinue?: boolean;
};
```

Algorithm:

```text
1. Validate request body.
2. Check Taskboard PBC intake idempotency.
3. Create visible wrkq task using the existing task-create logic.
   - Title: request.title
   - Body/description: rawFeedback plus context/source if useful
   - Labels: include PBC marker label if wrkq supports labels
4. Persist task_id in intake idempotency store.
5. Call ACP POST /v1/pbc/tasks/:taskId/start:
   {
     idempotencyKey,
     intake: {
       rawFeedback,
       source,
       context,
       priority,
       labels
     },
     autoContinue
   }
6. Persist ACP response.
7. Return:
   {
     task,
     pbc,
     job?
   }
```

Failure behavior:

```text
wrkq task creation fails:
  no task_id persisted; return error.

wrkq task created, ACP start fails:
  return task plus a retryable PBC start error when possible.
  The task page should offer Retry start/continue.

ACP start succeeds, response lost:
  retry replays from Taskboard store or ACP idempotency.
```

Implementation detail: extract the existing task-creation logic from the current admin route into a helper such as `createTaskInContainer({ project, containerId, body, actor })` so `/admin/pbc/intakes` does not duplicate container resolution and wrkqd task detail fetch behavior.

---

## `GET /admin/pbc/tasks/:taskId`

Query parameters:

```text
workspaceId optional but recommended
containerId optional
```

Algorithm:

```text
1. Fetch ACP PBC projection from GET /v1/pbc/tasks/:taskId.
2. If workspaceId is present, fetch wrkq task detail through existing Taskboard helpers.
3. Merge into a Taskboard response:
   {
     task?,
     pbc
   }
4. Do not require wrkq detail to render if ACP projection already has enough task metadata.
```

This route powers the PBC task page and polling after form submissions.

---

## `POST /admin/pbc/tasks/:taskId/input`

Request:

```ts
type SubmitPbcInputRequest = {
  idempotencyKey: string;
  kind: 'clarification_response' | 'patch_decision';
  data:
    | { answer: string; acceptedDefault?: boolean }
    | { route: 'finalize' | 'revise'; note?: string; acceptedPatch?: boolean };
};
```

Algorithm:

```text
1. Validate kind and data shape.
2. Forward to ACP POST /v1/pbc/tasks/:taskId/input.
3. Return ACP projection/job response.
```

Taskboard should not send obligation IDs, transition IDs, role, actor, revision, or contextHash. ACP derives those from current wrkf state and authenticated actor.

---

## `POST /admin/pbc/tasks/:taskId/continue`

Request:

```ts
type ContinuePbcRequest = {
  idempotencyKey: string;
};
```

Algorithm:

```text
1. Forward to ACP POST /v1/pbc/tasks/:taskId/continue.
2. Return projection plus active/replayed job.
```

Use this for manual retry/resume buttons and for intake continuation if the initial start response indicates the job was not admitted.

---

## `POST /admin/pbc/tasks/:taskId/dispose`

Request:

```ts
type DisposePbcRequest = {
  idempotencyKey: string;
  resolution: 'wont_fix' | 'duplicate' | 'unclear' | 'out_of_scope';
  reason: string;
};
```

Algorithm:

```text
1. Validate resolution and non-empty reason.
2. Forward to ACP POST /v1/pbc/tasks/:taskId/dispose.
3. Return disposed projection.
```

Disposition should be hidden or disabled when ACP projection does not expose a disposition action.

---

## `GET /admin/pbc/jobs/:jobId`

Proxy ACP `GET /v1/pbc/jobs/:jobId`.

Response:

```ts
type PbcJobResponse = {
  job: {
    id: string;
    taskId: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    stopReason?: string;
  };
  pbc?: PbcTaskProjection;
};
```

The web page should poll while status is `queued` or `running`, then refetch the task projection.

---

## Shared schemas

Add `packages/shared/src/schema/pbc.ts` and export it from the shared package.

Recommended schemas:

```text
PbcScreenSchema
PbcArtifactViewSchema
PbcTaskProjectionSchema
CreatePbcIntakeRequestSchema
CreatePbcIntakeResponseSchema
SubmitPbcInputRequestSchema
ContinuePbcRequestSchema
DisposePbcRequestSchema
PbcJobResponseSchema
```

Keep schemas permissive for diagnostics/raw fields but strict for product-critical fields:

```text
screen
actions
currentInput.kind
artifact data shapes
job status
input request data
```

---

## Web API client

Add functions to `apps/web/src/api/client.ts`:

```ts
export function createPbcIntake(input: CreatePbcIntakeRequest): Promise<CreatePbcIntakeResponse>;

export function fetchPbcTask(input: {
  taskId: string;
  workspaceId?: string;
  containerId?: string;
}): Promise<PbcTaskResponse>;

export function submitPbcInput(
  taskId: string,
  input: SubmitPbcInputRequest
): Promise<PbcTaskResponse>;

export function continuePbcTask(
  taskId: string,
  input: ContinuePbcRequest
): Promise<PbcTaskResponse>;

export function disposePbcTask(
  taskId: string,
  input: DisposePbcRequest
): Promise<PbcTaskResponse>;

export function fetchPbcJob(jobId: string): Promise<PbcJobResponse>;
```

Use the same fetch/error handling conventions as existing task APIs.

The browser should generate and preserve an `idempotencyKey` for each user action. For intake, persist the key in component state and do not regenerate it on retry.

---

## Web routes

Add routes in `apps/web/src/routes.tsx` before greedy workspace/container routes:

```text
/pbc/new
/pbc/:workspaceId/:taskId
/workspace/:workspaceId/pbc/new        # optional convenience route
```

Route ordering matters because the existing router has greedy workspace/container task routes.

Recommended components:

```text
apps/web/src/routes/PbcIntakeRoute.tsx
apps/web/src/routes/PbcTaskRoute.tsx
apps/web/src/components/pbc/PbcArtifactPanel.tsx
apps/web/src/components/pbc/PbcClarificationForm.tsx
apps/web/src/components/pbc/PbcPatchDecisionForm.tsx
apps/web/src/components/pbc/PbcJobPoller.tsx
apps/web/src/components/pbc/PbcFinalView.tsx
apps/web/src/components/pbc/PbcDisposedView.tsx
apps/web/src/components/pbc/PbcDiagnosticsPanel.tsx
```

---

## Intake page

Route: `/pbc/new`

Fields:

```text
workspace / project
container
title
raw feedback / request
source
context
priority
labels
auto-continue toggle, default true
```

Submit behavior:

```text
1. Generate idempotencyKey once per draft submission.
2. Call createPbcIntake.
3. Navigate to /pbc/:workspaceId/:taskId.
4. If ACP start failed after task creation, navigate to the task page with retryable error state.
```

The task title should remain user-facing. The raw feedback should be stored both in the wrkq task body/description and in ACP PBC `intake_metadata.data.rawFeedback`.

---

## PBC task page

Route: `/pbc/:workspaceId/:taskId`

Data loading:

```text
1. Fetch /admin/pbc/tasks/:taskId?workspaceId=:workspaceId.
2. Render task metadata plus PBC projection.
3. If projection.activeJob exists, start polling /admin/pbc/jobs/:jobId.
4. Refetch task projection after job success/failure.
```

Page sections:

```text
header:
  title, wrkq state, workflow phase, status

main artifact panel:
  intake
  behavior note
  pre-interview analysis
  clarification response
  PBC draft
  pressure pass
  patch decision
  final PBC
  disposition

action panel:
  continue/retry button
  clarification form
  patch decision form
  dispose form/button

job panel:
  queued/running/succeeded/failed state
  stop reason
  retry action when allowed

diagnostics panel:
  legal transitions
  obligations
  effects
  warnings
  raw ids only for operator use
```

Diagnostics should be collapsible by default. Product users should see PBC status and artifacts first, not wrkf internals.

---

## Screen behavior

The ACP PBC projection should include a `screen` field. Taskboard should render from that field, not by reverse-engineering wrkf phases.

```text
starting:
  Show initialization/progress. Poll if activeJob exists.

working:
  Show current artifacts and active job/progress. Disable forms.

clarification:
  Show pre-interview analysis, question/default answer, and clarification form.

patch_decision:
  Show draft, pressure pass, suggested patch/final candidate, and patch decision form.

finalized:
  Show final PBC prominently, with provenance artifacts below.

disposed:
  Show disposition resolution/reason.

blocked:
  Show product-safe blocked message and retry/diagnostic action if enabled.

error:
  Show failure message, retry if ACP action says continue is enabled, diagnostics collapsed.
```

### Clarification form

Input:

```text
answer
accept default answer checkbox, if default exists
```

Submit:

```ts
submitPbcInput(taskId, {
  idempotencyKey,
  kind: 'clarification_response',
  data: { answer, acceptedDefault },
});
```

### Patch-decision form

Input options:

```text
Finalize with accepted patch/final candidate
Revise, with note
```

Submit:

```ts
submitPbcInput(taskId, {
  idempotencyKey,
  kind: 'patch_decision',
  data: {
    route: 'finalize' | 'revise',
    note,
    acceptedPatch,
  },
});
```

Do not let users hand-edit raw `pbc_final` JSON in the first implementation. If final text editing is needed later, add a product-specific final content field and let ACP convert it to validated `pbc_final` evidence.

---

## Job polling

Initial implementation should poll; SSE can come later.

```text
poll interval: 1-2s while queued/running
stop polling on succeeded/failed
on stop, refetch task projection
show retry only if ACP projection exposes actions.continue.enabled
```

Avoid long browser requests. `continue` and `input` should return quickly with a job when agent work is needed.

---

## Error handling

Taskboard should normalize ACP errors into product-safe messages while preserving details in diagnostics.

Recommended mapping:

```text
409 idempotency_conflict:
  “This action was already submitted with different content.”

409 workflow_conflict:
  “This task already has a different active workflow.”

409 stale / context mismatch:
  Refetch projection and ask user to retry.

422 invalid_input:
  Show field-level validation when possible.

503 WRKF_UNAVAILABLE or ACP unavailable:
  Show retryable backend-unavailable state.

worker failed:
  Show failed job status and retry/diagnostic panel.
```

If task creation succeeded but ACP start failed, the response should include the created task and a `pbcStartError`. The UI should navigate to the task page and offer retry rather than losing the created task.

---

## Authorization and actor handling

Product-owner evidence must be tied to the authenticated user. Taskboard should not let the browser supply arbitrary actor identities for PBC inputs.

Recommended behavior:

```text
- Derive actor from existing Taskboard auth/session/header conventions.
- Forward actor to ACP in a trusted server-to-server way.
- Do not include actor fields in browser request schemas.
- Show actor/provenance in artifact metadata when ACP returns it.
```

---

## Implementation plan

### Phase 1 — Server proxy and schemas

```text
- Add makeAcpClient to apps/api/src/server.js.
- Add shared PBC zod schemas.
- Add /admin/pbc/jobs/:jobId proxy.
- Add /admin/pbc/tasks/:taskId get proxy.
- Add web API client functions for get/job.
```

### Phase 2 — Intake route and idempotency

```text
- Extract existing task-create logic into a reusable helper.
- Add durable PBC intake idempotency store or equivalent wrkqd idempotency integration.
- Implement POST /admin/pbc/intakes.
- Add createPbcIntake web client function.
- Build /pbc/new page.
```

### Phase 3 — PBC task page and polling

```text
- Add /pbc/:workspaceId/:taskId route.
- Render ACP PBC projection.
- Add artifact panel, final/disposed views, and diagnostics.
- Add job polling.
```

### Phase 4 — Human input forms

```text
- Implement POST /admin/pbc/tasks/:taskId/input.
- Add clarification form.
- Add patch-decision form.
- Add idempotency handling for form submissions.
```

### Phase 5 — Continue/dispose actions

```text
- Implement continue proxy and retry button.
- Implement dispose proxy and form/button.
- Hide/disable actions based on ACP projection.actions.
```

### Phase 6 — UX hardening

```text
- Add empty/error/loading states.
- Add route links from task detail pages to PBC page when task has PBC workflow metadata.
- Optionally add SSE updates after polling is stable.
```

---

## Acceptance criteria

### Server

```text
- /admin/status still reports acp_url.
- Taskboard can call ACP through a reusable client with normalized errors.
- /admin/pbc/intakes creates a visible wrkq task and starts ACP PBC workflow.
- Intake retry with same idempotency key does not create duplicate visible tasks.
- Intake retry after task-created/ACP-start-failed resumes from recorded task_id.
- /admin/pbc/tasks/:taskId returns ACP PBC projection and wrkq task metadata when available.
- /admin/pbc/tasks/:taskId/input never accepts actor, transition ID, obligation ID, revision, or contextHash from browser body.
- /admin/pbc/tasks/:taskId/continue returns quickly with projection/job.
- /admin/pbc/tasks/:taskId/dispose forwards explicit human disposition only.
- /admin/pbc/jobs/:jobId proxies job status for polling.
```

### Web

```text
- User can create a PBC from /pbc/new.
- User lands on /pbc/:workspaceId/:taskId with visible task metadata and PBC status.
- Working state polls job status and refreshes projection.
- Clarification state renders a usable clarification form.
- Patch-decision state renders finalize/revise controls.
- Finalized state shows final PBC content prominently.
- Disposed state shows resolution and reason.
- Blocked/error state shows retry when ACP exposes continue action.
- Diagnostics are available but not the primary UX.
```

### Integration

```text
- Taskboard intake -> wrkq task create -> ACP PBC start -> job admitted.
- Taskboard page observes job completion and final PBC projection.
- Clarification form -> ACP input -> continuation -> final path.
- Patch decision finalize -> ACP input -> finalized path.
- Patch decision revise -> ACP input -> worker creates fresh draft path.
- Network retry during intake does not duplicate task when idempotency store is enabled.
```
