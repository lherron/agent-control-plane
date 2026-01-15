USER:
Expound on multi-agent composition and changes needed.  A single WorkItem should definitely support multiple sessions/agents running on a task (sometimes in parallel) and should be a coordination point across agents.

---------------------------------------------------------------------------------------------------------
GPT-5.2-PRO:

Multi-agent composition actually makes the **WorkItem-in-control-plane** concept *more* important, not less.
When you allow multiple agents/sessions to work the same WRKQ task (sometimes in parallel), you need a **single coordination object** that can:

- represent **multiple in-flight edges** (runs) against one task
- enforce **resource concurrency** (who can write to the repo? who can update the WRKQ task? who is read-only?)
- provide a **shared “blackboard”** (plan, decisions, current working context) so agents don’t diverge
- unify observability (session IDs, transcripts, configs) without shoving high-churn data into WRKQ’s task row (which is intentionally stable)  [oai_citation:0‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)

Below is a concrete model for multi-agent composition and the changes needed across the three projects.

---

## 1) Multi-agent composition: what you’re really enabling

There are three common concurrency cases you’ll hit immediately:

### A. Parallel read-only work (safe)
Examples:
- Implementer is coding while Reviewer reads diffs and tests plan.
- Triager extracts requirements while Dependency agent scans dependencies.

This is safe as long as they share consistent context (task snapshot + repo snapshot) and don’t race on WRKQ updates.

### B. Parallel “side-effect” work that must be serialized
Examples:
- Two agents both want to update WRKQ state/meta/comment.
- Two agents both want to mark the task “blocked” or “completed”.

This requires a **single-writer rule** for the WRKQ task mutation path (or robust merge logic with optimistic concurrency), regardless of how many agents are running.

WRKQ’s state machine and dependency semantics should remain canonical and stable (idea/draft/open/in_progress/blocked/completed/…)  [oai_citation:1‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c), so CP must be careful about conflicting updates.

### C. Parallel write-to-repo work (hard)
Examples:
- Two implementers both changing code simultaneously.
- An implementer writing code while a fixer agent refactors another part.

You can support this, but you must choose a model:
1) **Exclusive write lock on a shared workspace** (simplest; fewer conflicts, less parallelism)
2) **Per-run isolated worktree + merge step** (true parallelism; requires merge/conflict handling)

If you want “sometimes in parallel” with multiple writers, you almost inevitably need (2) at some point.

---

## 2) Recommended control-plane model for multi-agent

Keep these as separate concerns:

- **WRKQ Task** = node-at-rest workflow state + dependency graph  [oai_citation:2‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)
- **WorkItem (rex)** = binding + coordination hub
- **Runs (rex)** = edges-in-flight; each run is “one agent/harness job” (triage/implement/review/test/etc.)
- **Sessions (rex / harness)** = runtime session identifiers for each agent job (often 1:1 with a run)
- **Locks (rex)** = concurrency control over shared resources
- **Workspaces (rex)** = where code changes happen (shared or per-run worktree)

### Key recommendation (for composition): “many runs per WorkItem, optionally hierarchical”
Model multi-agent as **multiple runs** attached to the same WorkItem:
- Run A: kind=implement, role=implementer (writer)
- Run B: kind=review, role=reviewer (reader)
- Run C: kind=test, role=tester (reader)
- Run D: kind=fix, role=fixer (writer), possibly *child* of implement run

Use:
- `parent_run_id` to express coordinator → worker relationships
- optionally `episode_id` to group “one orchestration wave” (see below)

This avoids “one run with many sessions” complexity, and maps well to how your harnesses behave (each job naturally has its own session/transcript).

---

## 3) What WorkItem must add for multi-agent coordination

### 3.1 WorkItem-level “blackboard”
A WorkItem should have a durable shared context that all agents can read/write **through CP**:

- canonical plan / task decomposition
- current assumptions / decisions log
- pointers to latest repo snapshot or baseline commit
- “what’s currently happening” summary (generated / maintained)

This should be **append-oriented** (events) plus an optional “current snapshot” for convenience.

**Why CP and not WRKQ meta?**  
Because WRKQ meta is task-centric and should remain lightweight; multi-agent coordination is a runtime concern and can be high churn.  [oai_citation:3‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)

### 3.2 WorkItem-level locking (resource coordination)
To allow parallel agents safely, CP needs a lock manager. Locks should be scoped to a WorkItem, but may refer to resources.

Minimal resources you’ll need:

- `wrkq_task_write` (exclusive): only one run at a time can apply state/meta/comment changes to the WRKQ task
- `repo_write` (exclusive OR per-workspace): controls who can modify the shared workspace (if using shared)  
  or controls “integration/merge” to the canonical branch (if using per-run worktrees)
- `repo_read` (shared): allow multiple readers
- `integration` (exclusive): only one run merges patches / finalizes changes

### 3.3 Workspaces (to make parallelism real)
Introduce a CP notion of **Workspace**:
- either a shared workspace per WorkItem (simple)
- or a workspace per run (git worktree) (parallel writers)

Each run records `workspace_id` so artifacts (diffs, logs) are attributable and reproducible.

---

## 4) Concrete rex changes for multi-agent

I’ll describe changes in terms of “minimum viable multi-agent” and “true parallel writers”.

### 4.1 Data model additions in rex

#### A) `work_items` (as previously proposed)
No change except: it should now support multiple active runs.

Add these fields (or equivalent in JSON policy):
- `policy_json`: include default lock policy, allowed concurrency, allowed run kinds
- (optional) `blackboard_snapshot_json`: latest synthesized summary snapshot (small)

#### B) Extend `runs` to support WorkItems and agent identity
Today `runs` are tied to (project_id, optional session_id) and store input/response/tool history.

Add:
- `work_item_id` (FK)
- `kind` (triage|implement|review|test|fix|coord|…)
- `role` (implementer|reviewer|tester|triager|coordinator|…)
- `agent_id` (stable identity for the worker)
- `parent_run_id` (for composition)
- `workspace_id` (where it ran)
- `required_locks_json` (declared lock needs)
- (optional) `capabilities_json` (readOnly/writeRepo/writeWrkq)

This is what allows CP to show “these 3 agents are actively working on this task, doing different things.”

#### C) Add `work_item_locks`
A proper lock table gives you correctness and observability:

- `lock_id`
- `work_item_id`
- `resource` (wrkq_task_write | repo_write | integration | repo_read)
- `mode` (exclusive | shared)
- `holder_run_id`
- `holder_agent_id`
- `acquired_at`, `expires_at`, `released_at`
- `meta_json` (e.g., “why held”, “renewal count”)

With:
- expiration/renewal to handle crashed agents
- optional “priority” for preemption policies

#### D) Add `work_item_events` (coordination log)
Event-sourced coordination is incredibly useful for multi-agent systems:

- `event_id`
- `work_item_id`
- `run_id` nullable
- `type` (message | decision | plan_update | lock_acquired | lock_released | run_spawned | checkpoint | …)
- `payload_json`
- `created_at`

This becomes your blackboard history + audit log + an easy SSE feed.

#### E) Add `run_outputs` (run-scoped artifacts)
You already have `session_outputs`. For multi-agent, a run-scoped artifact index is cleaner because:
- some runs may use multiple sessions/have none
- artifacts should attach to the attempt (run), not just the session

Store:
- transcript path(s)
- events.jsonl path
- patch/diff
- summary.md

### 4.2 Service-level changes in rex

#### A) WorkItemCoordinator service
Add a control-plane service that:
- resolves WRKQ task → WorkItem (create idempotently)
- starts runs with declared locks
- maintains “active run list” per WorkItem
- posts WorkItem events
- applies WRKQ updates through a single “apply patch” function (serialized)

This is the *hub* for multi-agent composition.

#### B) LockManager
Implement:
- `acquire(work_item_id, resource, mode, holder_run_id, ttl)`
- `renew(lock_id)`
- `release(lock_id)`
- compatibility rules (shared/exclusive)
- dead-holder detection by run heartbeat or explicit cancel

#### C) WorkspaceManager (two modes)
**MVP (shared workspace):**
- create `workspace_id` per WorkItem
- exclusive `repo_write` lock required to mutate files

**Parallel writers (worktree mode):**
- create per-run worktrees (`workspace_id` = run_id)
- store baseline commit
- output patch artifact
- require `integration` lock for “merge/apply patch” step

### 4.3 API changes in rex (needed for agents)
Add endpoints (or internal-only calls) for:

- `POST /work-items/by-wrkq` (ensure binding)
- `GET /work-items/:id` (includes blackboard + active runs summary)
- `POST /work-items/:id/runs` (start run with kind/role/locks/workspace)
- `POST /work-items/:id/locks/acquire|renew|release`
- `POST /work-items/:id/events` (agent writes coordination messages)
- `GET /work-items/:id/events` (SSE stream for coordination + observability)
- `POST /work-items/:id/apply` (apply WRKQ changes / repo changes through a controlled merge)

This is what makes WorkItem a real coordination point rather than just a foreign-key join.

---

## 5) Multi-agent in-flight state calculation (updated)

With multi-agent, a WorkItem can have **N active runs**.

### 5.1 “Active runs” definition
Treat these statuses as in-flight edges:
- `queued`, `injecting`, `launched`, `running`, `awaiting_permission`

(Completed/failed/cancelled are not in-flight.)

### 5.2 Derived WorkItem phase (human-friendly)
Compute:

- `activeKinds = set(activeRuns.kind)`
- show:
  - `phase.primary` = highest-priority kind among active runs  
    Priority example: `implement > triage > review > test > fix > coord`
  - `phase.secondary` = the rest, for visibility

Example rendering:
- “Implementing (active: implement, review, test)”
- “Triaging (active: triage, dependency_scan)”
- “Blocked (no active runs; WRKQ state blocked)”

### 5.3 Coordination alerts
Because multi-agent systems fail in new ways, add derived flags:
- `needsAttention = any(run.status == awaiting_permission)`
- `stalled = any(activeRun.lastHeartbeatAt older than grace)`
- `conflict = lock contention detected OR repeated WRKQ etag conflicts`

This makes WorkItem the “air traffic control tower.”

---

## 6) Changes needed in agent-spaces-v2 for multi-agent runtime

To support multiple agents in parallel and to make CP observability correct, agent-spaces runtime needs a stronger contract:

### 6.1 Each SDK harness job must emit: session identity + structured events
Right now (especially pi-sdk runner, pi-agentsdk), session ID is implicit (session file path in hook context) and not emitted for CP to record.

For multi-agent, every job should emit **structured JSONL events** to stdout (or a file path CP controls), including:

- `job_started { workItemId, runId, harnessId, pid }`
- `session_started { harnessSessionId }` (or session file path)
- `message { role, content, … }`
- `tool_call/tool_result`
- `heartbeat`
- `job_completed { exitCode, outcome }`

That allows rex to:
- set run heartbeats
- store transcript artifacts reliably
- correlate multi-agent runs in one WorkItem

### 6.2 Pass WorkItem/Run context into the harness
Add environment/context injection:
- `CP_WORK_ITEM_ID`
- `CP_RUN_ID`
- `CP_AGENT_ROLE`
- `CP_TRACE_ID`
- plus “read-only vs write” capabilities (so tools can enforce policy)

### 6.3 Concurrency + cancellation
Your runtime layer should support:
- spawning multiple jobs concurrently (already possible with spawn)
- cancellation (SIGTERM + cleanup)
- output path control (so each run writes to its own artifact directory)

---

## 7) Minimal WRKQ changes (still minimal even with multi-agent)

WRKQ remains the node/state system with dependency semantics  [oai_citation:4‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c).

For multi-agent, the only WRKQ requirements are:

1) **Optimistic concurrency stays solid** (etag/if-match).  
2) **Stop treating task row as “current run status” ledger** for multiple agents.  
   With multiple parallel runs, “cp_run_id current-only” becomes incorrect by definition.

Optional (but useful):
- add `cp_work_item_id` on task as a stable pointer (one value works fine even with many runs).

All multi-agent execution history belongs in rex.

---

## 8) Multi-agent composition patterns you can support with this

### Pattern 1: Coordinator + workers (hierarchical)
- Coordinator run (kind=coord, role=coordinator) starts first, posts plan to WorkItem.
- Spawns child runs:
  - implementer (repo_write)
  - reviewer (repo_read)
  - tester (repo_read)
- Coordinator monitors events and decides when to integrate/close.

### Pattern 2: Parallel read-only assistants (flat)
No parent/child necessary:
- Start implement + review + test runs concurrently
- Locks prevent conflicting writes
- WorkItem events keep shared context consistent

### Pattern 3: Parallel writers with merge gate (advanced)
- Each writer gets own workspace (worktree) and produces a patch artifact
- An integration run (exclusive `integration` lock) merges patches and resolves conflicts
- Only integration run is allowed to apply final repo changes + WRKQ completion updates

This is where WorkItem-as-coordinator becomes essential.

---

## 9) Summary of “what changes for multi-agent” in one list

**rex**
- WorkItem becomes mandatory hub for task-bound agent work
- runs gain: `work_item_id`, `kind`, `role`, `agent_id`, `parent_run_id`, `workspace_id`
- add: lock manager tables + events blackboard + run outputs
- API: list active runs for a WorkItem, lock acquire/release, events stream

**agent-spaces-v2**
- runtime emits structured events and session identity
- accepts CP metadata (workItemId/runId/role)
- supports concurrent jobs + cancellation + deterministic output paths

**wrkq**
- no new lifecycle states needed (keep stable state machine)  [oai_citation:5‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)
- optionally add `cp_work_item_id`
- deprecate “current-only run/session scalar fields” as anything other than legacy display cache

---

If you want, I can now write an explicit **lock compatibility matrix** (shared/exclusive interactions) and a concrete **“implement+review+test in parallel”** sequence diagram showing exactly which service calls happen in rex and what artifacts land where.


--------------------------------------------------------------------------------------------------
USER:

Your proposal leaves implicit the run kinds/roles and role construction/constraints.  Especially the coordinator should have a list of possible agents (or roles) available to complete the work item.  I don't want the system constrained to "follow these 3 steps to finish a coding task" - it should be open-ended enough for the coordinator to actually coordinate, but not so generic that the coordinator just spawns multiple "everything agents".  I am not looking for RBAC type security constraints - only some ability to guide what agent spaces/roles are available to coordinator.  Also consider if this should be associated to edge states, ie "triage role is only role that can move a task from draft to open".

Give me a proposal for management of roles and association of roles to work items.  Also consider if this is a responsibility outside of control-plane.  Do we need another system?

Finally, give me a bare-bones MVP for a multi-agent control-plane that incorporates all of your recommendations so far, including your original recommended changes based on the project repositories you have access to.  Roles can be hard-coded for now.  Include a full work_items data model.








---------------------------------------------------------------------------------------------------
GPT-5.2-PRO:



It also includes a **bare-bones MVP spec** for multi-agent rex (control-plane) with a **full `work_items` data model**, hard-coded roles, and the repo-level changes needed across **wrkq**, **rex**, and **agent-spaces-v2**.

---

## 1) Make “run kind” and “role” first-class, distinct concepts

You’re trying to manage two different axes:

### Run kind
“What is the attempt doing?” (edge semantics)
- examples: `coord`, `triage`, `implement`, `review`, `test`, `fix`, `investigate`, `doc`, `refactor`, …
- This should be **open-ended** (string / soft-enum). You don’t want the system hard-coded to “3 steps.”

### Role
“What *kind of agent* is allowed to do this work?” (capability profile + config selector)
- examples: `coordinator`, `triager`, `implementer`, `reviewer`, `tester`
- This should be **constrained** and intentionally limited per WorkItem, so you don’t end up with 5 generic “do everything” agents.

**Key rule:**  
A run always has exactly one `role`, and one `kind`.  
A role **permits** a set of kinds (and constraints), but doesn’t dictate a fixed workflow.

---

## 2) Role management proposal

### 2.1 RoleDefinition (catalog / template)
A role is a “capability profile + agent-space selector + orchestration constraints.”

**RoleDefinition fields (conceptual):**
- `role_name`: stable identifier (`triager`, `implementer`, …)
- `description`: what it’s for
- `allowed_run_kinds`: list (e.g. triager can do `triage` / `investigate`)
- `agent_config_selector`: how to pick runtime config
  - reference an agent-spaces target/profile (ideal), or
  - embed a selector `{ harnessId, aspTarget, model, yolo, … }`
- `lock_requirements`: what must be held before side-effects
  - `wrkq_task_write` exclusive for task mutation
  - `repo_write` exclusive for shared workspace writes
  - (optional) `integration` exclusive if you later adopt per-run worktrees + merge gate
- `capabilities` (not RBAC security; guardrails):
  - `repo_access`: `none|read|write`
  - `wrkq_mutations`: `none|comment_only|labels|state_transitions|full`
  - `can_spawn_roles`: boolean (true for coordinator only)
- `allowed_wrkq_transitions`: list of `(from_state, to_state)` pairs that this role is allowed to apply *via rex*
  - Example you asked for: **only triage role can move `draft → open`**.
- `max_parallel_per_work_item`: optional guardrail (e.g. 1 implementer at a time)

WRKQ states remain canonical and stable (`idea/draft/open/in_progress/blocked/completed/cancelled/archived/deleted`).  [oai_citation:0‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)  
We enforce “who can move between them” **in rex** when applying automated patches.

### 2.2 WorkItemRoleBinding (per-work-item palette)
A WorkItem needs a *palette* of roles that the coordinator is allowed to use for that task.

A binding is basically:  
“for this WorkItem, these roles are available (and maybe overridden).”

Fields:
- `work_item_id`
- `role_name`
- `enabled`
- `overrides_json` (optional):
  - per-role model override
  - per-role harness override
  - tighten/expand allowed kinds (rare; usually don’t)
  - concurrency override
- `max_parallel_override`

**Coordinator behavior**: the coordinator can only spawn roles enabled on the WorkItem.

### 2.3 RunRoleAssignment (per run)
Every run stores:
- `work_item_id`
- `role_name`
- `kind`
- `agent_config_snapshot_json` (what was actually used)
- `session_refs_json` / session IDs / transcript pointers

This is the observability ledger you were missing when IDs were scalars.

---

## 3) “Triage role is the only role that can move draft → open”
You want this kind of “association to edge states.”

This is cleanly expressed as **transition guardrails**, enforced in rex:

### Enforcement point
When a run tries to apply a patch to WRKQ (state/meta/labels/comment), rex calls a single “apply task patch” function, and does:

1) Determine the WRKQ state transition requested (`from → to`)
2) Look up the run’s `role_name`
3) Validate `(from,to)` is in that role’s `allowed_wrkq_transitions`
4) Acquire `wrkq_task_write` lock (exclusive)
5) Apply update using WRKQ’s optimistic concurrency (`etag`) to avoid lost updates

This leverages WRKQ’s existing state semantics and avoids adding more workflow states (which is expensive due to CHECK constraints/migrations).  [oai_citation:1‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)

---

## 4) Where should roles live?
You asked whether this belongs outside control-plane or needs a new system.

### You do not need a new system.
But you do want **two layers**:

#### A) **Definition source** (configuration)
Longer-term best place: **agent-spaces-v2**, because it’s already your config registry/harness layer and is versioned.
- Store role definitions in a file that agent-spaces already governs (or near it), e.g.
  - `asp-roles.toml` (new)
  - or extend `asp-targets.toml` with `[roles.*]` blocks
- Each role points at an agent-spaces target/profile and includes orchestration hints (allowed kinds, transitions, lock needs).

#### B) **Enforcement and coordination** (runtime policy)
Must live in **rex**:
- rex owns WorkItem lifecycle, run spawning, lock arbitration, and patch application.
- rex is where you compute “in-flight edges” and present a unified observability view.

So: **definitions can be outside rex**, but enforcement should remain inside rex. No fourth service required.

For the MVP you requested, roles can be hard-coded in rex.

---

## 5) Bare-bones MVP: multi-agent control-plane with WorkItems + hard-coded roles

This MVP assumes:
- Multiple agents can run on the same WorkItem in parallel.
- You will serialize side effects via locks.
- You will not yet implement per-run worktrees; you’ll use a shared workspace + `repo_write` lock.

### 5.1 Hard-coded MVP role catalog
Example catalog (in rex code, e.g. `packages/control-plane/src/work-items/roles.ts`):

**Roles**
- `coordinator`
  - allowed kinds: `coord`
  - can spawn roles: ✅
  - repo access: `read`
  - wrkq mutations: `comment_only` (or none)
  - allowed transitions: none (or very limited)
- `triager`
  - allowed kinds: `triage`, `investigate`
  - repo access: `read`
  - wrkq mutations: state + labels + comment
  - allowed transitions:
    - `draft → open`
    - `draft → cancelled`
    - `draft → blocked` (optional)
- `implementer`
  - allowed kinds: `implement`, `fix`, `refactor`
  - repo access: `write`
  - wrkq mutations: comment + transitions
  - allowed transitions:
    - `open → in_progress`
    - `in_progress → completed`
    - `open|in_progress → blocked`
- `reviewer`
  - allowed kinds: `review`
  - repo access: `read`
  - wrkq mutations: comment only
  - allowed transitions: none
- `tester`
  - allowed kinds: `test`
  - repo access: `read` (or `write` if you allow generating artifacts, but not committing)
  - wrkq mutations: comment only
  - allowed transitions: none

This is open-ended because:
- you can add new run kinds anytime (`security_scan`, `dependency_update`, `doc`, …)
- but you must map them to a role (or add a role) before the coordinator can use them

So you don’t get “spawn 5 everything agents.”

---

## 6) Full `work_items` data model (rex)

Below is a complete MVP schema that fits rex’s existing SQLite + TS migration style (`packages/control-plane/src/db/migrations/*.ts`).

### 6.1 Tables

#### `work_items`
```sql
CREATE TABLE IF NOT EXISTS work_items (
  work_item_id TEXT PRIMARY KEY,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  -- binding to WRKQ
  source_kind TEXT NOT NULL CHECK (source_kind IN ('wrkq')),
  source_ref_json TEXT NOT NULL,     -- { dbPath, taskUuid, taskId, path? }
  task_state_cache TEXT,             -- optional denorm cache
  task_etag_cache INTEGER,           -- optional denorm cache
  task_updated_at_ms_cache INTEGER,  -- optional denorm cache

  -- coordination / policy
  policy_json TEXT NOT NULL,         -- { allowedRoles:[...], concurrency:{...}, transitionRules?:... }
  blackboard_json TEXT,              -- { plan, notes, checkpoints } or a small summary snapshot
  coordinator_run_id TEXT,           -- pointer to current coordinator run (optional)

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS work_items_project_id ON work_items(project_id);
CREATE INDEX IF NOT EXISTS work_items_last_activity ON work_items(last_activity_at DESC);
```

#### `work_item_roles`
```sql
CREATE TABLE IF NOT EXISTS work_item_roles (
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  role_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  max_parallel INTEGER,
  role_overrides_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, role_name)
);
```

#### `work_item_locks`
```sql
CREATE TABLE IF NOT EXISTS work_item_locks (
  lock_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,

  resource TEXT NOT NULL CHECK (resource IN ('wrkq_task_write','repo_write','repo_read','integration')),
  mode TEXT NOT NULL CHECK (mode IN ('exclusive','shared')),

  holder_run_id TEXT,
  holder_session_id TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,

  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS work_item_locks_work_item ON work_item_locks(work_item_id);
CREATE INDEX IF NOT EXISTS work_item_locks_active ON work_item_locks(work_item_id, resource, released_at);
```

*(In practice you’ll also want a partial unique index for “one active exclusive lock per resource,” but SQLite partial indexes are fine to add once you’re ready.)*

#### `work_item_events` (optional but extremely useful even in MVP)
```sql
CREATE TABLE IF NOT EXISTS work_item_events (
  event_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  run_id TEXT,
  type TEXT NOT NULL,              -- 'note'|'decision'|'spawn'|'lock'|'checkpoint'...
  payload_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS work_item_events_work_item ON work_item_events(work_item_id, created_at DESC);
```

#### Extend existing `runs` table
Add columns (migration alters):
- `work_item_id TEXT REFERENCES work_items(work_item_id) ON DELETE SET NULL`
- `kind TEXT` (run kind)
- `role_name TEXT` (role assignment)
- `parent_run_id TEXT`
- `workspace_id TEXT` (MVP can be null or set to project root identifier)
- `agent_config_snapshot_json TEXT`
- `session_refs_json TEXT` (array of backend IDs, provider IDs, etc.)
- `last_heartbeat_at INTEGER`

This aligns with your need to track many session IDs/config snapshots over time.

#### `run_outputs` (recommended even in MVP)
```sql
CREATE TABLE IF NOT EXISTS run_outputs (
  output_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'events'|'transcript'|'diff'|'report'
  storage_root_kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER,
  content_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS run_outputs_run ON run_outputs(run_id);
```

---

## 7) MVP API surface (rex)

### 7.1 WorkItem endpoints
- `POST /work-items/by-wrkq`
  - input: `{ projectId, dbPath, taskUuid, taskId? }`
  - behavior: create idempotently; initialize role bindings from hard-coded catalog
- `GET /work-items/:workItemId`
  - returns: binding info + allowed roles + active runs + derived phase
- `POST /work-items/:workItemId/runs`
  - input: `{ kind, roleName, parentRunId?, prompt?, overrides? }`
  - validates: role enabled + kind allowed + concurrency constraints
  - starts a run (creates a session per run in MVP)
- `GET /work-items/:workItemId/runs`
- `POST /work-items/:workItemId/apply`
  - input: `{ runId, taskPatch }`
  - enforces: transition allowed for role + lock + WRKQ etag update

### 7.2 Derived “phase”
Computed from:
- WRKQ task state (canonical)  [oai_citation:2‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)
- + any active runs on the WorkItem
So you still get: **draft → triaging → open → implementing → closed**, but “triaging/implementing” are edges-in-flight.

---

## 8) Repo-by-repo recommended changes for MVP

### 8.1 rex changes (control-plane)
This is the bulk of the MVP.

1) **DB migrations**
- add tables: `work_items`, `work_item_roles`, `work_item_locks`, (optional) `work_item_events`, `run_outputs`
- alter `runs` to add the work-item and role fields

2) **New module: WorkItemCoordinator**
- ensure/create WorkItem for a WRKQ task
- start runs with roles
- enforce lock acquisition for side-effects
- apply WRKQ patches with transition guardrails

3) **Update existing WRKQ routers**
Your current `wrkq-router/triage.ts` updates WRKQ columns like `cp_run_id`, `cp_session_id`, `sdk_session_id`, and `run_status` repeatedly during polling. For multi-agent, that model breaks because those columns are scalars.

MVP change:
- `triage_wrkq` should:
  - ensure WorkItem exists
  - start a run with `kind='triage'`, `role='triager'`
  - store session IDs and config snapshot in rex tables
  - write a WRKQ comment when finished (fine)
  - **stop polling WRKQ to keep `run_status` current** (that becomes rex’s job)

4) **Compatibility stance on WRKQ scalar CP fields**
For MVP, keep them as “legacy last-run pointer” if you must for UI compatibility, but treat rex WorkItem/Runs as canonical.

5) **Event/heartbeat support**
- store `last_heartbeat_at` for each run (from backend events or periodic ping)
- drive “stalled agent” UX from rex, not WRKQ

### 8.2 wrkq changes (tasks)
WRKQ’s state machine stays as-is (don’t add new states like `triage`; it’s expensive and not needed)  [oai_citation:3‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c).

MVP changes:
1) **(Optional) add `cp_work_item_id` to tasks**
- One stable pointer is useful and doesn’t become invalid under multi-agent.
- Update `v_task_paths` to include it.
- Update CLI JSON output types to show it.

2) **Deprecate “async run linkage” columns as canonical**
`cp_run_id/cp_session_id/sdk_session_id/run_status` remain in schema for now (dropping columns is hard), but they should no longer be treated as “the truth.” With multi-agent they cannot represent reality.

3) **Keep using WRKQ optimistic concurrency (`etag`)**
This is critical for rex’s apply‑patch step.

### 8.3 agent-spaces-v2 changes (run harness)
Roles don’t require a new system, but multi-agent orchestration becomes dramatically better if agent-spaces-v2 provides a consistent runtime contract.

MVP-friendly changes:
1) **Emit structured run events (JSONL) from harness jobs**
Especially for `pi-sdk/runner.ts`, emit:
- `session_started` with the harness session identifier (or session file path)
- tool call/result events
- heartbeat events
- completion

2) **Accept CP context env vars**
- `CP_WORK_ITEM_ID`, `CP_RUN_ID`, `CP_ROLE`, `CP_KIND`, `CP_TRACE_ID`

3) **Deterministic artifact output directory**
So rex can attach transcripts/diffs cleanly per run.

These changes align with your refactor goal (move runtime mechanics out of rex) without requiring a new orchestration service.

---

## 9) Why this satisfies your constraints
- **Open-ended composition:** coordinator can spawn any sequence/combination of kinds, as long as it picks from allowed roles.
- **Not “everything agents”:** the WorkItem role palette is limited, and each role is constrained (kinds, locks, allowed transitions).
- **Edge-state authority:** “triage role only can do `draft → open`” is enforced where it matters—when rex applies a patch to WRKQ.
- **No new system needed:** definitions can live in agent-spaces config later; enforcement stays in rex; WRKQ stays stable.  [oai_citation:4‡WRKQ_STATE_MACHINE_SPEC.md](sediment://file_00000000f15071fdac97d7497600479c)

---

If you want the next step, I can map this MVP into concrete file-level edits in rex (which migrations to add, what to change in `wrkq-router/triage.ts`, and the minimal new `work-items` router/service/repo classes to implement first).
