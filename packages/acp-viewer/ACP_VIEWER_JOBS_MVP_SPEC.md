# ACP Viewer State MVP Spec

Reference concept image:

![Light JobFlow concept](/Users/lherron/.codex/generated_images/019e16de-fd11-7250-b914-47ff75c1e519/ig_041a571a7ab16304016a01cb41fa5081969172fe4b93351de9.png)

Use that light theme as the primary visual reference: compact left nav, Jobs selected, bright workbench surface, center JobFlow canvas with arrows, right-side step inspector, and bottom provenance/data-source strip.

## Product Direction

Build `packages/acp-viewer` as a local-only ACP state viewer. The MVP should focus on durable state and configuration, not operational execution timelines.

The Jobs area should answer:

- What jobs exist?
- What does each job do?
- How does it start?
- When is it scheduled?
- What JobFlow is defined?
- What SQLite-backed state can we inspect for this job?

Execution history should be secondary and contextual: recent runs for the selected job or selected step, not a global dashboard of all job runs.

## MVP Scope

The MVP is read-only.

Do not add or surface create/update/delete actions in the MVP:

- No Create Job button.
- No Create Task button.
- No Create Agent button.
- No Create Project button.
- No mutation controls for jobs, tasks, agents, projects, memberships, interface bindings, deliveries, or runs.
- No new create endpoints are needed for the viewer MVP.

It is acceptable to add read endpoints, enriched read endpoints, or a BFF/direct SQLite access layer where current ACP routes cannot expose the needed state cleanly.

## Tech Stack

- Package: `packages/acp-viewer`
- Runtime/package manager: Bun
- App: React + TypeScript + Vite
- UI: shadcn/ui + Tailwind
- Icons: lucide-react
- Data fetching: TanStack Query
- Local state: Zustand or TanStack Store
- Tables: TanStack Table
- Flow visualization: React Flow or custom SVG/HTML flow cards for MVP
- Validation/parsing: shared TypeScript types where available; add viewer-specific DTOs if API shape differs
- Auth: none
- Deployment: local-only
- Data access: prefer direct ACP read endpoints; add viewer/BFF endpoints only where current ACP routes cannot expose SQLite state cleanly

## MVP Emphasis

State first:

- projects
- agents
- memberships
- job definitions
- schedules
- startup inputs
- JobFlow definitions
- step definitions
- computed next fire state
- disabled/enabled state
- data provenance across SQLite stores

Defer richer execution views:

- global job-run timeline
- live job-run monitoring
- full run logs
- per-step output replay
- cross-job operational dashboards

## Primary Pages

### 1. Projects

Purpose: static inventory of ACP projects and the state attached to each project.

Main data:

- `projectId`
- `displayName`
- `defaultAgentId`
- `rootDir`
- `createdAt`
- `updatedAt`
- `createdBy`
- `updatedBy`
- memberships
- project-scoped jobs
- project-scoped interface bindings, if available
- project-scoped system events

UI:

- left nav with Projects selected
- project table/list grouped by active/default agent
- selected project detail panel
- tabs:
  - Overview
  - Agents
  - Jobs
  - Interfaces
  - System Events
  - Raw
- no create/edit/delete/default-agent controls in the MVP

Overview:

- display name
- root directory
- default agent
- created/updated timestamps
- actor stamps

Agents:

- memberships for the project
- agent status
- role
- heartbeat summary, if available

Jobs:

- jobs filtered by `projectId`
- state-focused summary: disabled, cron, nextFireAt, kind, flow step count

Interfaces:

- bindings filtered by `projectId`
- gatewayId, conversationRef, threadRef, scopeRef, laneRef, status

System Events:

- project-scoped append-only events
- useful for understanding how project state changed

Existing API:

- `GET /v1/admin/projects`
- `GET /v1/admin/projects/:projectId`
- `GET /v1/admin/projects/:projectId/memberships`
- `GET /v1/admin/jobs?projectId=:projectId`
- `GET /v1/interface/bindings?projectId=:projectId`
- `GET /v1/admin/system-events?projectId=:projectId`

Needed API update:

- Add enriched project detail endpoint:
  - `GET /v1/admin/projects/:projectId/detail`
- Include:
  - raw project
  - memberships
  - member agent summaries
  - default agent summary
  - jobs summary
  - interface bindings summary
  - recent system events
  - data provenance

### 2. Agents

Purpose: static inventory of ACP agents and their configured participation across projects, jobs, and runtime targets.

Main data:

- `agentId`
- `displayName`
- `homeDir`
- `status`
- `createdAt`
- `updatedAt`
- `createdBy`
- `updatedBy`
- memberships
- heartbeats
- jobs assigned to the agent
- project defaults that point at the agent

UI:

- left nav with Agents selected
- agent table/list with status, project memberships, default-project count, assigned jobs, heartbeat state
- selected agent detail panel
- tabs:
  - Overview
  - Projects
  - Jobs
  - Heartbeat
  - Scope Targets
  - Raw
- no create/edit/delete/heartbeat-wake controls in the MVP

Overview:

- display name
- homeDir
- status
- created/updated timestamps
- actor stamps

Projects:

- memberships grouped by project
- role
- whether the agent is the default agent for that project

Jobs:

- jobs filtered by `agentId` where available
- state-focused summary: disabled, projectId, cron, nextFireAt, kind, flow step count

Heartbeat:

- latest heartbeat
- status alive/stale
- source/note
- targetScopeRef/targetLaneRef

Scope Targets:

- scopeRef/laneRef combinations reachable from project memberships and assigned jobs
- useful for understanding where the agent can be dispatched

Existing API:

- `GET /v1/admin/agents`
- `GET /v1/admin/agents/:agentId`
- `GET /v1/admin/projects`
- `GET /v1/admin/projects/:projectId/memberships`
- `GET /v1/admin/jobs`

Current gap:

- There is a heartbeat store, but no read route for agent heartbeat state in the route table today.
- There is no direct `GET /v1/admin/agents/:agentId/detail` join endpoint.
- There is no direct `GET /v1/admin/agents/:agentId/jobs` endpoint.

Needed API updates:

- Add enriched agent detail endpoint:
  - `GET /v1/admin/agents/:agentId/detail`
- Include:
  - raw agent
  - memberships
  - related project summaries
  - jobs assigned to the agent
  - project defaults pointing at this agent
  - heartbeat summary
  - scope/lane targets
  - data provenance
- Add heartbeat read endpoint if not covered by detail:
  - `GET /v1/admin/agents/:agentId/heartbeat`
  - or `GET /v1/admin/heartbeats`

### 3. Jobs Catalog

Purpose: static inventory of jobs.

Main data:

- `jobId`
- `projectId`
- `agentId`
- `scopeRef`
- `laneRef`
- `schedule.cron`
- schedule window fields if present
- `disabled`
- `lastFireAt`
- `nextFireAt`
- `input`
- `flow`
- `createdAt`
- `updatedAt`
- actor stamp

UI:

- left nav with Jobs selected
- top search/filter bar
- grouped jobs list by project/agent
- table columns:
  - State
  - Job
  - Project / Agent
  - Schedule
  - Kind: input / flow / exec
  - Next fire
  - Last fire
  - Summary
- selected job drives detail panel
- no create/edit/delete buttons

Existing API:

- `GET /v1/admin/jobs`

Needed API update:

- Add optional enriched list endpoint or query:
  - `GET /v1/admin/jobs?include=summary,state`
- Response should include:
  - computed `kind`
  - human-friendly `summary`
  - `flowStepCount`
  - `onFailureStepCount`
  - latest run status summary
  - next fire display fields

### 4. Job Detail

Purpose: explain one durable job definition.

Tabs:

- Overview
- Startup
- Schedule
- Flow
- Runs
- Raw

Overview:

- identity
- project/agent
- scope/lane
- enabled state
- actor stamp
- created/updated timestamps

Startup:

- `input.content`
- input template JSON
- source metadata
- scopeRef/laneRef dispatch target
- expected startup behavior

Schedule:

- cron
- nextFireAt
- lastFireAt
- scheduling window
- disabled reason, if available
- computed next N fires

Flow:

- embedded JobFlow summary
- sequence steps
- onFailure steps
- step kind, timeout, fresh, next, branches, expectations

Runs:

- secondary latest runs only
- no global chronological dashboard

Existing API:

- `GET /v1/admin/jobs/:jobId`
- `GET /v1/jobs/:jobId/runs`

Needed API update:

- `GET /v1/admin/jobs/:jobId/detail`
- Include:
  - raw job
  - computed kind/summary
  - parsed schedule summary
  - next fire previews
  - latest run summary
  - related project
  - related agent
  - memberships
  - latest input attempt/application/queue state if linked

### 5. JobFlow Detail

Purpose: make JobFlows first-class.

This page should closely follow the reference image.

Main view:

- large flow canvas
- sequence lane
- onFailure lane
- arrows for `next`
- branch labels: continue / succeed / fail / onFailure
- selected step highlighted

Step card fields:

- `id`
- `kind`
- `timeout`
- `fresh`
- `next`
- agent input or exec argv summary
- expectation summary

Right inspector:

- Definition
- Startup
- Expectations
- Last Runs
- Raw

Existing API:

- `GET /v1/admin/jobs/:jobId` includes `flow`
- `GET /v1/job-runs/:jobRunId` includes steps for flow runs

Needed API update:

- Could be covered by `GET /v1/admin/jobs/:jobId/detail`
- Optional focused endpoint:
  - `GET /v1/admin/jobs/:jobId/flow`
- Include normalized flow:
  - `sequence[]`
  - `onFailure[]`
  - computed edges
  - selected-step-friendly DTOs
  - validation warnings

### 6. Scheduler State

Purpose: show whether scheduling itself is healthy, without becoming an execution dashboard.

UI:

- scheduler enabled/running
- tick interval
- last tick
- next tick
- due jobs count
- claimed count
- scheduler errors
- stale leases

Needed API:

- `GET /v1/admin/jobs/scheduler`
- Or BFF/direct SQLite equivalent

This should be a small status panel, not a primary page for MVP.

### 7. Data Provenance / State Map

Purpose: expose how the viewer assembled the selected job state.

Show linked stores/tables:

- `jobs_store.jobs`
- `jobs_store.job_runs`
- `jobs_store.job_step_runs`
- `admin_store.projects`
- `admin_store.agents`
- `admin_store.memberships`
- `acp_state.runs`
- input attempts / queue / applications
- HRC runs/sessions if available
- interface deliveries / conversation turns when linked

Needed API:

- `GET /v1/admin/jobs/:jobId/lineage`
- Or include `lineage` in job detail endpoint

This is state lineage, not an execution timeline.

## Data/API Strategy

Start with direct ACP read endpoints where possible. Add server endpoints when the viewer needs computed joins or SQLite-only state.

Preferred new MVP endpoint:

```txt
GET /v1/admin/jobs/:jobId/detail
```

Suggested shape:

```ts
type JobDetailResponse = {
  job: JobRecord
  summary: {
    kind: 'input' | 'flow' | 'exec'
    title: string
    description?: string
    disabledReason?: string
    flowStepCount: number
    onFailureStepCount: number
  }
  schedule: {
    cron: string
    lastFireAt?: string
    nextFireAt?: string
    nextFirePreview?: string[]
    windowStart?: string
    windowEnd?: string
    windowMinutes?: number
  }
  startup: {
    scopeRef: string
    laneRef: string
    input: Record<string, unknown>
    actor?: unknown
  }
  flow?: {
    sequence: NormalizedFlowStep[]
    onFailure: NormalizedFlowStep[]
    edges: Array<{ from: string; to: string; label: string }>
    warnings: string[]
  }
  latestRuns: JobRunRecord[]
  provenance: Array<{ source: string; available: boolean; note?: string }>
}
```

Additional enriched read endpoints for MVP navigation:

```txt
GET /v1/admin/projects/:projectId/detail
GET /v1/admin/agents/:agentId/detail
```

Suggested project detail shape:

```ts
type ProjectDetailResponse = {
  project: AdminProject
  defaultAgent?: AdminAgent
  memberships: Array<AdminMembership & { agent?: AdminAgent }>
  jobs: Array<{
    job: JobRecord
    summary: {
      kind: 'input' | 'flow' | 'exec'
      disabled: boolean
      nextFireAt?: string
      lastFireAt?: string
      flowStepCount: number
      onFailureStepCount: number
    }
  }>
  interfaceBindings: InterfaceBinding[]
  recentSystemEvents: SystemEvent[]
  provenance: Array<{ source: string; available: boolean; note?: string }>
}
```

Suggested agent detail shape:

```ts
type AgentDetailResponse = {
  agent: AdminAgent
  memberships: Array<AdminMembership & { project?: AdminProject; isDefaultAgent: boolean }>
  jobs: Array<{
    job: JobRecord
    summary: {
      kind: 'input' | 'flow' | 'exec'
      projectId: string
      disabled: boolean
      nextFireAt?: string
      lastFireAt?: string
      flowStepCount: number
      onFailureStepCount: number
    }
  }>
  heartbeat?: AgentHeartbeat
  scopeTargets: Array<{ scopeRef: string; laneRef: string; source: 'membership' | 'job' }>
  provenance: Array<{ source: string; available: boolean; note?: string }>
}
```

## Implementation Notes

- Build the real viewer from the light concept, not the current dark static prototype.
- Avoid hero/marketing composition.
- Use dense tables and inspector panels.
- Keep cards shallow; no nested decorative card stacks.
- Use icons for actions.
- Add Projects and Agents as read-only state pages before deeper execution views.
- Let Projects and Agents link into filtered Jobs state.
- Use JobFlow as a definition blueprint.
- Keep Runs and Step Runs subordinate to selected job/step.
- Do not build a global job execution timeline for MVP.
- Do not add mutation buttons or create/edit forms in the MVP.

## Handoff Summary

The MVP is a read-only ACP state explorer centered on Projects, Agents, and Jobs: project/agent catalog -> filtered jobs -> selected job -> startup/schedule/flow/state lineage. Execution views come later and should be launched from job detail, job run rows, or selected flow steps.
