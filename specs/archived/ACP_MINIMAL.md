# ACP Minimal — Defect Workflow MVP

A self-contained briefing for a fresh Claude Opus instance picking up this work.
Everything needed to execute should be in this document or linked from it.

For the Discord human-interface implementation track, also read
[`ACP_MINIMAL_INTERFACE.md`](./ACP_MINIMAL_INTERFACE.md). That document covers
the minimal binding, ingress, response-capture, and Discord egress surface, and
it treats `../control-plane/packages/gateway-discord` as the research and
reuse baseline for Discord mechanics.

---

## 0. Planning session resolutions (2026-04-19)

These decisions were made in a coordinator planning session with the user and
supersede anything below that conflicts. Read these first. §12 open questions
are all resolved here; traceable answers are kept in §12 for reference.

**Scope for this run.** Execute the full §10 sequence, *with §10.1 (repo
rename) deferred*. Keep the `agent-spaces` directory name and the
`@lherron/agent-spaces` npm package for now. Revisit the rename after MVP
ships.

**wrkq schema coordination.** Coordinate schema additions with the wrkq
maintainer agents — `cody@wrkq` or `clod@wrkq` via `hrcchat dm`. Do **not**
proceed to `packages/wrkq-lib` until wrkq has merged and shipped the agreed
schema. This is the longest-pole blocker; start it first.

**SQLite layout.** One file per package. `wrkq.db` is owned by wrkq;
wrkq-lib is a client. `coordination.db` is owned by
`packages/coordination-substrate`. No cross-database foreign keys —
correlate through `links.taskId`.

**No GuidancePacket abstraction.** The typed `GuidancePacket` concept from
`TASK_WORKFLOWS.md §6.4` is *not* implemented in the MVP. Instead:
- The launcher (acp-server, when dispatching a role-scoped session via
  HRC) computes `{phase, requiredEvidenceKinds, hintsText}` for the
  `(preset, task, role)` triple and sets env vars on the child:
  `HRC_TASK_ID`, `HRC_TASK_PHASE`, `HRC_TASK_ROLE`,
  `HRC_TASK_REQUIRED_EVIDENCE` (comma-separated kinds), `HRC_TASK_HINTS`
  (pre-rendered text).
- The system-prompt renderer reads those env vars and appends a short
  "Current task context" block when present.
- A small pure helper in `acp-core` renders `hintsText` from the preset so
  the agent-facing text stays derived from the same preset that the
  server-side validator enforces. This preserves the single-source-of-truth
  invariant between gate enforcement and agent guidance without needing a
  typed packet.
- Revisit the packet abstraction when role overlays or a second preset
  arrive. MVP may carry explicit waiver evidence without introducing a
  richer approval surface.

**ACP ↔ ASP coupling: none.** ASP does **not** import `acp-core`, does
**not** import `wrkq-lib`, does **not** read tasks. Task context flows into
the run only via env vars populated by the launcher. ASP stays plane-clean:
it knows agents, spaces, placements — not tasks/presets/roles. This
supersedes §12.4's (c) recommendation.

**Agent identity on HTTP.** Accept `actor.agentId` as a request header or
body field. No auth boundary (spec warning in `TASK_WORKFLOWS.md §6.2` that
ScopeRef is not an auth boundary still applies).

**Authz model.** Membership-only. No hub authority in MVP.

**Demo agents for E2E.** `larry` as `implementer`, `curly` as `tester`.
Distinct agent ids are required so the SoD validator has something real to
reject when the implementer attempts `green → verified`.

**Dispatch model during implementation.** Each §10 phase is executed by a
cody session scoped to its wrkq task handle — `cody@agent-spaces:T-XXXXX`.
Each task gets its own session continuity; phases are coordinated via
`hrcchat dm` and wrkq state. The wrkq schema proposal specifically
dispatches to `cody@wrkq` or `clod@wrkq` instead.

**Dispatch order.**
- **Parallel kickoff:** §10.2 (wrkq schema proposal, via cody@wrkq or
  clod@wrkq), plus §10.4 / §10.5 / §10.6 (pure-TS, no wrkq dependency).
- **Sequential after wrkq ships the schema:** §10.3 (wrkq-lib), then §10.7,
  §10.8, §10.9, §10.10, §10.11 in order.

---

## 0.5 Implementation status (2026-04-19) — MVP shipped

The §10 plan executed end-to-end. All §14 Definition-of-Done items
demonstrated. The list below is the source of truth for what landed; the
detailed phase descriptions in §10 still describe the original intent.

### Phases

| § | wrkq | Deliverable | Tests | Status |
|---|------|-------------|-------|--------|
| 10.1 | — | repo rename | — | **DEFERRED** per §0 |
| 10.2 | T-01134 | wrkq schema (4 cols + 3 tables, migration `000013_task_workflow_schema.sql`) | go test ✓ | shipped |
| 10.3 | T-01137 | `packages/wrkq-lib` | 21/21 | shipped |
| 10.4+5 | T-01135 | `packages/acp-core` (preset, validator, task-context, 6 ported regressions) | 20/20 | shipped (combined — see deviations) |
| 10.6 | T-01136 | `packages/coordination-substrate` | 11/11 contract | shipped |
| 10.7 | T-01138 | `packages/acp-server` HTTP surface | 37/37 | shipped |
| 10.7+ | T-01143 | `acp-server` Bun.serve bin (follow-up — see deviations) | bin smoke ✓ | shipped |
| 10.8 | T-01139 | `HRC_TASK_*` env-var threading (system-prompt + cli-adapter + launcher) | 23/23 | shipped |
| 10.9 | T-01140 | `packages/acp-cli` | 21/21 | shipped |
| 10.10 | T-01141 | `packages/acp-e2e` (full §2 scenario) | 8/8 sub-tests | shipped |
| 10.11 | T-01142 | `acp task promote` + endpoint (wrkq intake wrapper) | promote tests + e2e sub-test | shipped |

**Cumulative bun-test count across new packages: ≈220 passing, 0 failing.**
A pre-existing unrelated `packages/hrc-server/src/__tests__/launch.test.ts`
ENOENT failure remains; it pre-dates this work.

### §14 Definition of Done — verified

- ✅ `wrkq touch --kind bug` → `acp task promote` produces a defect-fastlane
  task with distinct `larry`/`curly` roles
- ✅ `acp task show --role <r>` renders the task-context block (current
  phase, required evidence, hints) — the spiritual successor to the
  deferred GuidancePacket
- ✅ Full `open → red → green → verified → completed` runs through the CLI
  with appropriate evidence
- ✅ `green → verified` attempted by the implementer's `agentId` returns
  422 `sod_violation`
- ✅ `red → green` writes one CoordinationEvent + one Handoff +
  one WakeRequest atomically (verified by reading `coordination.db`
  directly in both the e2e and the live smoke)
- ✅ Tester intent receives `HRC_TASK_*` env vars; `materializeSystemPrompt`
  emits the "Current task context" block when they're present
- ✅ 6 ported regression tests pass in `acp-core`
- ✅ 11 coordination-substrate contract tests pass
- ✅ 8 acp-e2e sub-tests pass (full §2 scenario in-process with recording
  mock launcher)

### Deviations from the spec as written

These are intentional choices made during execution; flagged so future
readers don't trust the original §10 phrasing literally.

1. **§10.4 + §10.5 combined into one task.** Both phases mutate
   `packages/acp-core`. Dispatching them as parallel siblings would have
   put two cody sessions on the same directory. Combined them into
   T-01135 to avoid the file-conflict trap. Spec listed them as
   parallel-safe; in practice the package boundary forces serialization.

2. **acp-server bin was added in a follow-up (T-01143), not §10.7.**
   The spec text in §7.3 framed the bin as "optional for MVP — the tests
   exercise the handler directly." That deferral made the entire CLI
   surface (§10.9) unusable end-to-end since it had nothing to talk to.
   The bin is `acp-server`, reads `ACP_WRKQ_DB_PATH` /
   `ACP_COORD_DB_PATH` / `ACP_PORT` / `ACP_HOST` / `ACP_ACTOR` env vars,
   logs a one-line startup banner, and exits cleanly on SIGINT/SIGTERM.

3. **`HrcRuntimeIntent.taskContext` lives at the top level**, not under
   `intent.placement.taskContext`. Putting it on `placement` would have
   coupled ASP/config to ACP, which §0 explicitly forbids. The launcher
   (acp-server) sets `intent.taskContext` directly; cli-adapter's
   `buildHrcCorrelationEnv` reads from there.

4. **wrkq-lib uses `bun:sqlite` at runtime, falls back to
   `better-sqlite3` elsewhere.** The original §7.1 said "Use
   better-sqlite3 or equivalent." better-sqlite3 doesn't load natively
   under Bun. The fix landed in T-01143 as a runtime conditional in
   `packages/wrkq-lib/src/sqlite.ts` rather than a global `bunfig.toml`
   preload (which would have required `bun:test` semantics that aren't
   safe at runtime).

5. **`acp task promote` chosen over a wrkq-side intake hook for §10.11.**
   The spec offered two options; chose the ACP-side wrapper to keep wrkq
   ACP-agnostic. No wrkq Go changes for §10.11. Promote is one-way for
   MVP — re-promoting an already-preset-driven task returns 409
   `already_preset_driven`.

6. **`POST /v1/tasks/:taskId/evidence` returns 204 No Content.** The
   `acp task evidence add --json` therefore prints `null` on success.
   E2E tests assert exit code rather than stdout payload.

7. **`acp-coordination.db` location.** Spec didn't dictate a path;
   chose `/Users/lherron/praesidium/var/db/acp-coordination.db` as
   sibling of the canonical `wrkq.db`. The bin auto-creates the file
   if missing.

8. **Demo agents `larry` (implementer) + `curly` (tester)** as resolved
   in §0. Both seeded as wrkq actors lazily by `wrkq-lib`'s
   `ActorResolver` on first reference.

9. **No GuidancePacket type** (per §0). The agent-facing context is a
   plain "Current task context" markdown section appended to the system
   prompt, sourced from `HRC_TASK_*` env vars. The server-side validator
   reads `requiredEvidenceKinds` from the same preset lookup that
   `computeTaskContext` uses, preserving the single-source-of-truth
   invariant without a typed packet.

### Live smoke (manual e2e against canonical state)

Verified `2026-04-19` against `/Users/lherron/praesidium/var/db/wrkq.db`
with the live `acp-server` bin and the live `acp` CLI:

- T-01144 created via `wrkq touch --kind bug`, promoted to defect-fastlane
- larry created `/tmp/acp-hello-world/hello.txt`
- Full transition sequence advanced through versions 3→4→5→6→7
- Handoff + Wake (`01KPM7GKMK…EKT` / `01KPM7GKMK…J18`) fired on red→green
- SoD probe (larry attempting verified) returned exit 1 with code
  `sod_violation`
- coordination.db inspection: exactly 1 event + 1 handoff + 1 wake linked
  to T-01144

---

## 1. Purpose

Build the minimum ACP surface needed for the `code_defect_fastlane` workflow
(riskClass=medium) to run end-to-end against real agents, with wrkq as the
authoritative Task store. This is a *greenfield* implementation inside this
repo, not a port of the existing `agent-control-plane` prototype.

The existing `/Users/lherron/praesidium/agent-control-plane` repo is to be
treated as archived / read-only. It was a prototype for replicating scenarios;
it accumulated drift (`personaId` residue, in-memory admin store, missing
`/evidence` endpoint — see `../agent-control-plane/acp-spec-drift.md`). Cherry
pick cleanly from it; do not try to migrate it.

## 2. Target workflow

**Preset:** `code_defect_fastlane` version `1` at `riskClass=medium`.

**Phase graph:** `open → red → green → verified → completed`

**Roles:** `triager`, `implementer`, `tester` (preferred for handoff and
independent verification; medium-risk requires an independent verifier, not
necessarily an exactly pre-assigned tester).

**Transition gates** (from
`../acp-spec/spec/orchestration/TASK_WORKFLOWS.md §5.2`):

| From → To | Allowed role | Required evidence |
|---|---|---|
| `open → red` | triager or implementer | `tdd_red_bundle` (repro; base build/version recommended) |
| `red → green` | implementer | `tdd_green_bundle` (fix ref + now-passing test) |
| `green → verified` | **tester** for medium/high risk, or `implementer` for low risk (SoD: `disallowSameAgentAsRoles: ["implementer"]`) | `qa_bundle` (smoke proof; build ref recommended) |
| `verified → completed` | owner or implementer (policy) | no hard gate; merge/deploy ref strongly recommended |

**End-to-end scenario the MVP must support:**

1. User runs `wrkq touch --project <p> inbox/bug -t "Title"` → creates a Task.
2. Task is promoted to preset-driven: `workflowPreset=code_defect_fastlane`,
   `presetVersion=1`, `riskClass=medium`. The demo path assigns distinct
   `implementer` and `tester` agents so handoff and independent verification
   are visible end-to-end, but fastlane does not require exact tester
   assignment as a hard gate.
3. Implementer session opens with role-scoped ScopeRef
   `agent:<impl>:project:<p>:task:<t>:role:implementer`, lane `main`. Agent
   sees a GuidancePacket (current phase, required evidence, hints).
4. Implementer produces a repro → attaches `tdd_red_bundle` evidence →
   transitions `open → red`.
5. Implementer writes fix → attaches `tdd_green_bundle` → transitions
   `red → green`.
6. ACP appends a `CoordinationEvent(kind=handoff.declared)`, opens a
   `Handoff(from=implementer, to=tester)`, and enqueues a `WakeRequest`
   targeting the tester's SessionRef — all in one transaction.
7. Tester wakes with role-scoped ScopeRef
   `agent:<test>:project:<p>:task:<t>:role:tester` → verifies → attaches
   `qa_bundle` → transitions `green → verified`. Medium-risk policy requires
   an independent verifier; SoD validator rejects if
   `actor.agentId == roleMap.implementer`.
8. Transition `verified → completed` closes the task; merge/deploy ref is
   strongly recommended close-out evidence rather than a mandatory blocker.

This is the smallest cut where the system demonstrates role-scoped
separation-of-duties, transactional handoff, and evidence-gated transitions
against real runtime execution.

## 3. Repo context

- **Monorepo:** `/Users/lherron/praesidium/agent-spaces` to be renamed
  `praesidium-runtime`. Agent-spaces no longer describes its scope — it now
  houses ASP, HRC, ACP, coordination substrate, and (eventually) conversation
  surface.
- **Rename steps:** directory rename, update `package.json` name,
  `asp-lock.json`, `asp-targets.toml`, any internal references, and any
  Justfile/CI paths. `AGENTS.md` should enumerate the planes and their
  authority seams.
- **Archived:** `/Users/lherron/praesidium/agent-control-plane` — read-only;
  used as a scenario-replay reference and a source of lift-able components
  (see §7).
- **wrkq is authoritative** for Task persistence. Its schema is fixed; TS is
  a consumer, never an owner. Schema migrations stay in wrkq's Go code.
  wrkq repo: `/Users/lherron/praesidium/wrkq`
  (`schema_dump.sql`, `WRKQ_STATE_MACHINE_SPEC.md`).

## 4. Spec sources of truth

Read these from `/Users/lherron/praesidium/acp-spec/spec/`:

- `foundations/CONCEPTS.md` — canonical entity definitions
- `foundations/MENTAL_MODEL.md` — authority boundaries
- `contracts/AGENT_SCOPE.md` — ScopeRef/LaneRef/SessionRef grammar
- `contracts/SESSION_EVENTS.md` — streaming/replay contract
- `orchestration/TASK_WORKFLOWS.md` — **primary spec for this work**
  - §2.2 defect preset definition
  - §3 roles + SoD
  - §4 evidence model
  - §5.2 defect transition gates
  - §6 TransitionPolicy validator
  - §6.4 GuidancePacket shape
  - §7.2 dry-run walkthrough
- `orchestration/COORDINATION_SUBSTRATE.md` — required because medium-risk
  triggers implementer → tester handoff
  - §6 entity shapes (CoordinationEvent, Handoff, WakeRequest)
  - §8.1 appendEvent transactional command
- `orchestration/API.md` — HTTP surface for `/tasks`, `/inputs`, `/runs`,
  `/messages`
- `orchestration/CLI.md` — user-facing command shapes
- `runtime/AGENT_SPACES.md` — ASP materialization
- `runtime/HRC.md` / `runtime/HRC_DETAIL.md` — runtime control seam

Entity poster for visual overview:
`/Users/lherron/praesidium/acp-spec/plates/01-entities.tsx`.

## 5. Minimum entities

### Shared upstream (already implemented in this repo)

- `ScopeRef`, `LaneRef`, `SessionRef` — `packages/agent-scope`.
  Already parses `agent:<id>:project:<pid>:task:<tid>:role:<role>` ancestry
  correctly (`packages/agent-scope/src/scope-ref.ts:48-174`). No work needed.

### ACP · Identity & placement (new)

- **Agent** — id + agentRoot only; SOUL.md/HEARTBEAT.md stubs acceptable for
  MVP.
- **Project** — id + rootDir.
- **Membership** — agent × project. Simplified authz: any member may hold
  any role.
- **RuntimePlacement** — already in repo; extend to accept task/role scope
  segments in placement resolution.

### ACP · Dynamic execution (new)

- **Session** — ACP projection of live conversation, keyed by SessionRef.
- **InputAttempt** — idempotent dispatch record.
- **Run** — execution record with dispatch fence (sessionId, generation).

### ACP · Workflow (new, persisted in wrkq via wrkq-lib)

- **Task** — fields: `taskId`, `projectId`, `kind`, `workflowPreset`,
  `presetVersion`, `phase`, `riskClass`, `lifecycleState`, `version`,
  role map.

### Workflow machinery (new, spec TASK_WORKFLOWS.md)

- **WorkflowPreset** — catalog entry for `code_defect_fastlane.v1`.
  Immutable. Carries phaseGraph, TransitionPolicy, guidance templates.
- **TransitionPolicy** — eight-step validator from §6.6.
- **EvidenceItem** — `{kind, ref, contentHash?, producedBy:{agentId,role},
  timestamp, build?:{id,version,env}}` per §4.1.
- **RoleMap** — `task_role_assignments(task_uuid, role, actor_uuid,
  assigned_at)` in wrkq schema-compatible shape.
- **Task context env vars** *(replaces GuidancePacket for MVP; see §0)* —
  the launcher sets `HRC_TASK_ID`, `HRC_TASK_PHASE`, `HRC_TASK_ROLE`,
  `HRC_TASK_REQUIRED_EVIDENCE`, `HRC_TASK_HINTS` on the launched run. The
  system-prompt renderer appends a short context block when present.

### Coordination substrate (new, required because of tester handoff)

- **CoordinationEvent** — immutable ledger row. For MVP we need at least
  `kind ∈ {"handoff.declared", "attention.requested"}`.
- **Handoff** — first-class record with
  `kind ∈ {"review", "tool-wait", "human-wait"}` (use `"review"` for
  tester); states `open | accepted | completed | cancelled`.
- **WakeRequest** — keyed by canonical SessionRef; states
  `queued | leased | consumed | cancelled | expired`.
- Transactional `appendEvent` command (§8.1) — event + handoff + wake
  written atomically.

### HRC (already implemented)

- `HrcContinuityRecord`, `hostSessionId`, `generation`, `HrcSessionRecord`,
  `HrcLaunchRecord`, `hrc-launch` — present in
  `packages/hrc-core`, `packages/hrc-server`. No new work.

### ASP (already implemented; minimal extension)

- `agentRoot`, `SOUL.md`, `HEARTBEAT.md`, `agent-profile.toml` — scaffolds OK
- `space:agent:`, `space:project:`, `RuntimeBundleRef`, `ResolvedInstruction`,
  `ResolvedSpace`, `ResolvedRuntimeBundle`, `InvocationSpec` — all present
- **Task context env vars** *(per §0 — no GuidancePacket type)*. The
  launcher (acp-server) composes task context and sets env vars on the
  child; ASP forwards them through. Required changes:
  - `packages/runtime/src/system-prompt.ts` — append a short "Current task
    context" block rendered from `HRC_TASK_*` env vars when present.
  - `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts` —
    `buildHrcCorrelationEnv()` forwards the `HRC_TASK_*` env vars received
    from the caller through to the child process environment.
  - `packages/config/src/resolver/placement-resolver.ts` is **not** touched.
    ASP does not read tasks or import `acp-core` / `wrkq-lib`.

### Deferred (explicitly out of scope for this MVP)

- `DeliveryRequest` — outputs go to stdout + task evidence; gateway delivery
  later.
- `Job` / `JobRun` — defects are not scheduled.
- `ConversationThread` / `ConversationTurn` — CLI + wrkq views serve as the
  human surface for MVP.
- `InterfaceIdentity` / `Binding` — no gateway ingress; intake is
  `wrkq touch inbox/bug`.
- `Waiver` — no break-glass until a real incident demands it.
- `code_feature_tdd` preset — defect fastlane is the only preset in the MVP
  catalog. The escalation rule ("auth/security/billing/data migrations →
  auto-escalate to `code_feature_tdd`") can stub-error until that preset
  lands.

## 6. Architectural decisions already made

1. **Greenfield in this repo**; do not uplift the old ACP.
2. **Monorepo rename:** `agent-spaces` → `praesidium-runtime`. **Deferred
   for MVP — see §0.**
3. **wrkq-lib is a TypeScript library over wrkq's SQLite file** — direct
   DB access. No daemon, no RPC, no wrkq CLI subprocess. Schema migrations
   remain in wrkq's Go code; TS never writes DDL.
4. **Task is persisted in wrkq.** All new task-related tables
   (`task_role_assignments`, `evidence_items`, `waivers`, `task_transitions`)
   must be proposed as wrkq schema additions — they live in wrkq's repo,
   not here. Coordinate with wrkq owner before adding.
5. **Preset catalog lives in TS** (`packages/acp-core/src/presets/`), not in
   wrkq. Presets are code, not data. Pinned per task via
   `workflowPreset` + `presetVersion` fields on the task row.
6. **Coordination substrate is SQLite-backed** (a separate file from wrkq's
   SQLite; or a separate schema namespace in the same file — decide based on
   lock-contention preference). Transactionally linked to wrkq only through
   `links.taskId` — no cross-database foreign keys.
7. **SoD enforcement is mandatory for MVP.** The `green → verified`
   validator must compare `actor.agentId` against the recorded implementer
   in the role map and reject identity.
8. **Medium-risk is the MVP default** for defect fastlane. Low-risk
   self-verify works too but is not the demo path.
9. **ASP role overlays are deferred.** Role-specific SOUL.md swaps are not
   in scope for MVP. The `HRC_TASK_HINTS` env var carries role-specific
   hints rendered from the preset (see §0); no packet type.

## 7. New packages to build

```
praesidium-runtime/
  packages/
    wrkq-lib/                   # TS over wrkq SQLite
    acp-core/                   # preset catalog, validator, models
    acp-server/                 # HTTP surface
    acp-cli/                    # user-facing CLI (or fold into packages/cli)
    coordination-substrate/     # event ledger + handoffs + wake queue
    conversation-surface/       # stub only for MVP
```

### 7.1 `packages/wrkq-lib`

Scope: open wrkq's SQLite file at a path provided by caller. Provide typed
reads and writes for:
- `tasks` (existing schema + new fields: `workflow_preset`,
  `preset_version`, `phase`, `risk_class` — **coordinate schema changes
  with wrkq owner**)
- `task_role_assignments` (new)
- `evidence_items` (new)
- `task_transitions` (new; audit log)
- `comments`, `attachments`, `actors` (existing, read-only for MVP)

Non-goals: no schema migrations, no business logic, no validation beyond DB
constraints. Thin data layer.

Shape: export typed repository classes (`TaskRepo`, `EvidenceRepo`,
`RoleAssignmentRepo`, `TransitionLogRepo`) with explicit methods. No ORM.
Use `better-sqlite3` or equivalent.

### 7.2 `packages/acp-core`

Contains:
- `src/presets/code_defect_fastlane.v1.ts` — preset definition: phaseGraph,
  `TransitionPolicy` rules with `allowedRoles`, `disallowSameAgentAsRoles`,
  `requiredEvidenceKinds`, `waiverKinds`, plus `guidance` per phase.
- `src/presets/registry.ts` — `getPreset(presetId, version): Preset`.
  Immutable.
- `src/validators/transition-policy.ts` — eight-step validator from §6.6.
- `src/models/` — `Task`, `EvidenceItem`, `RoleMap`, `InputAttempt`, `Run`,
  `Session` types and pure functions. *No `GuidancePacket` type — see §0.*
- `src/wrkq-client.ts` — wraps `wrkq-lib` with ACP semantics (e.g., ensures
  `version` bumping on updates).
- `src/task-context.ts` — pure helpers mapping `(preset, task, role) →
  { phase, requiredEvidenceKinds, hintsText }`. The launcher calls these to
  populate `HRC_TASK_*` env vars at dispatch time. The server-side
  validator reads `requiredEvidenceKinds` from the same preset lookup, so
  agent guidance and gate enforcement stay in sync without a packet type.

Depends on: `packages/wrkq-lib`, `packages/agent-scope`.

### 7.3 `packages/acp-server`

HTTP endpoints (match `../acp-spec/spec/orchestration/API.md`):
- `POST /v1/tasks` — accepts `workflowPreset`, `presetVersion`,
  `riskClass`, role map
- `GET /v1/tasks/:taskId` — returns task + current phase,
  `requiredEvidenceKinds`, and rendered `hintsText` for the actor's role
  (derived via `task-context.ts`; no separate packet type per §0)
- `POST /v1/tasks/:taskId/transitions` — runs TransitionPolicy validator
- `GET /v1/tasks/:taskId/transitions` — audit log
- `POST /v1/tasks/:taskId/evidence` — attach without transitioning
- `POST /v1/inputs` — idempotent input attempt
- `GET /v1/runs/:runId`
- `POST /v1/messages` — append CoordinationEvent + optional handoff/wake
  (via `coordination-substrate`)
- `POST /v1/runtime/resolve` — SessionRef → RuntimePlacement
- `POST /v1/sessions/resolve` — SessionRef → concrete sessionId (delegates
  to HRC)

Server framework: follow existing agent-spaces style (Hono? Fastify? check
what `hrc-server` uses and match).

### 7.4 `packages/acp-cli`

User-facing commands (cherry-pick shape from old ACP):
- `acp task create --preset code_defect_fastlane --preset-version 1
  --risk-class medium --project <p> --role implementer:<a>
  --role tester:<a>`
- `acp task show --task <t>` — renders GuidancePacket
- `acp task evidence add --task <t> --kind <k> --ref <r>
  [--build-ref <b>]`
- `acp task transition --task <t> --to <phase> --actor-role <r>
  --expected-version <n> --evidence <ref>[,...]`
- `acp task transitions --task <t>` — audit log

### 7.5 `packages/coordination-substrate`

SQLite-backed per `COORDINATION_SUBSTRATE.md §5-7`.

Tables:
- `coordination_events` — append-only
- `coordination_event_participants`
- `handoffs`
- `wake_requests`
- `local_dispatch_attempts` — minimal for MVP (no-op acceptable)
- `projection_cursors`
- `coordination_event_links` (taskId, runId, sessionId)

Commands:
- `appendEvent(cmd)` — transactional event + optional handoff + optional
  wake + optional local dispatch
- `listPendingWakes(sessionRef)`, `leaseWake`, `consumeWake`
- `listOpenHandoffs(filter)`, `acceptHandoff`, `completeHandoff`

**Hard rule (§8.2):** wake requests must carry a canonical SessionRef.
Reject callers that supply only agentId / projectId / transport metadata.

### 7.6 `packages/conversation-surface`

Stub only for MVP. Export interface types so `coordination-substrate` can
link to `conversationThreadId` / `conversationTurnId` without being blocked
by a missing dependency. No UI, no storage.

## 8. Components to lift from old ACP

From `/Users/lherron/praesidium/agent-control-plane`:

- `packages/acp-cli/src/scope-input.ts` — role-scoped ScopeRef parsing and
  normalization. Works correctly; port as-is.
- `packages/control-plane/src/acp/task-core.test.ts` — 6 semantic contracts
  (task CRUD with version 0; versioned transitions; version conflict
  detection; evidence requirement for preset tasks; preset immutability;
  transition history). Port as regression tests against the new
  implementation.
- `packages/acp-cli/src/acp.ts:249-296` — task subcommand skeleton structure
  (not the implementation).
- `TaskRecord` field shape from
  `packages/control-plane/src/acp/task-store.ts` — field list is spec-aligned;
  port the type, reimplement the store against wrkq-lib.

## 9. Components to leave behind

- `packages/acp/src/admin-store.ts`, `packages/control-plane/src/acp/admin-store.ts`
  — `personaId`-driven, in-memory, no agent-home integration.
- Any in-memory `TaskStore` — replaced by wrkq-backed client.
- `packages/session-agent-spaces` — the cross-repo bridge collapses when the
  planes share a repo.
- Gateway / delivery worker code — deferred for MVP.

## 10. Work sequencing

Each step should be a mergeable unit.

1. **[DEFERRED]** Repo rename `agent-spaces` → `praesidium-runtime`.
   Skipped for MVP per §0. Revisit after MVP ships. Still worth doing as a
   one-off: archive `agent-control-plane` (add README pointer, mark
   read-only) — no rename required. Also update `AGENTS.md` with the
   three-plane narrative and seams under the current repo name.
2. **Propose wrkq schema additions** to the wrkq maintainer agents —
   `cody@wrkq` or `clod@wrkq` via `hrcchat dm`. Proposal covers:
   `workflow_preset`, `preset_version`, `phase`, `risk_class` columns on
   `tasks`; new tables `task_role_assignments`, `evidence_items`,
   `task_transitions`. Do not proceed on wrkq-lib until wrkq has merged and
   shipped the agreed schema. Dispatch this in parallel with §10.4-6 since
   those have no wrkq dependency.
3. **`packages/wrkq-lib`**: thin TS layer over wrkq's SQLite. Repositories
   only. Unit-test against a temp SQLite file.
4. **`packages/acp-core` skeleton**: types + `code_defect_fastlane.v1` preset
   + preset registry + GuidancePacket derivation. Pure functions; no I/O.
   Port the 6 regression tests from the old ACP.
5. **TransitionPolicy validator**: eight-step algorithm from §6.6. Unit-test
   each rejection path (role mismatch, SoD violation, missing evidence,
   stale version, unknown transition). Include the SoD case where
   `actor.agentId == roleMap.implementer` for `green → verified`.
6. **`packages/coordination-substrate`**: SQLite storage + `appendEvent`
   transactional command + read-side queries. Contract tests from §13.
7. **`packages/acp-server` endpoints**: `/tasks`, `/tasks/:id/evidence`,
   `/tasks/:id/transitions`, `/inputs`, `/runs`, `/messages`,
   `/runtime/resolve`, `/sessions/resolve`. Wire TransitionPolicy to
   `/transitions`. Wire `appendEvent` to `/messages` when body requests
   handoff/trigger.
8. **Task context injection via env vars** (no packet — see §0):
   - acp-server, when launching a role-scoped session, calls
     `acp-core/task-context.ts` to compute
     `{phase, requiredEvidenceKinds, hintsText}` for `(preset, task, role)`
     and sets `HRC_TASK_ID`, `HRC_TASK_PHASE`, `HRC_TASK_ROLE`,
     `HRC_TASK_REQUIRED_EVIDENCE`, `HRC_TASK_HINTS` on the HRC launch
     request.
   - `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`
     `buildHrcCorrelationEnv()` forwards those env vars to the child.
   - `packages/runtime/src/system-prompt.ts` appends a short "Current task
     context" block rendered from the env vars when present.
   - `placement-resolver.ts` is **not** touched. ASP does not read tasks
     or import `acp-core` / `wrkq-lib`.
9. **`packages/acp-cli`**: subcommands listed in §7.4.
10. **End-to-end integration test**: the §2 scenario as an automated
    test. Two distinct agent ids acting as implementer and tester. Assert
    SoD rejection when the same agent attempts both. Assert the
    implementer → tester handoff writes event + handoff + wake atomically.
    Assert GuidancePacket reaches the running agent's context.
11. **wrkq intake hook**: teach `wrkq touch inbox/bug` (or wrap at a new
    `acp task create-from-wrkq` layer) to set `workflow_preset`,
    `preset_version`, `risk_class=medium` on bug-kind tasks. Coordinate
    with wrkq owner on whether this lives in wrkq or in an ACP-side
    watcher.

## 11. Contract tests (from spec §13 COORDINATION_SUBSTRATE)

Must pass before the substrate is considered done:
1. Exact semantic triggering (SessionRef required for wake).
2. Append-only history (events are immutable).
3. Source / target / transcript separation.
4. Projection rebuildability.
5. Project isolation.
6. Idempotent writes.
7. Handoff visibility (queryable without text inference).
8. HAL read-model support (coordination slice derivable).
9. ACP delivery boundary preservation.
10. Replay ordering (stable per-project sequence).
11. Conversation correlation.

## 12. Open questions — resolved

All resolved in the 2026-04-19 planning session. See §0 for the definitive
statements; answers inline below for traceability.

1. **wrkq schema coordination.** Resolved: coordinate via `cody@wrkq` or
   `clod@wrkq` over `hrcchat dm`. Do not proceed to wrkq-lib until wrkq
   merges and ships the schema. Read `../wrkq/WRKQ_STATE_MACHINE_SPEC.md`
   and `../wrkq/AGENTS.md` before drafting the proposal.
2. **SQLite file(s).** Resolved: one file per package (`wrkq.db` owned by
   wrkq; `coordination.db` owned by `coordination-substrate`). No shared
   attached DB.
3. **HTTP framework choice.** Still an implementation detail — match
   whatever `packages/hrc-server` uses; do not introduce a new one. The
   executing agent confirms this while starting §10.7.
4. **ACP ↔ ASP call shape.** Resolved: *none*. ASP does not read tasks,
   does not import `acp-core`, does not import `wrkq-lib`. Task context
   flows into the run via env vars populated by acp-server at launch.
   Supersedes the spec's (c) recommendation.
5. **Hub / membership authz.** Resolved: membership-only. No hubs in MVP.
6. **Agent identity / actor.** Resolved: `actor.agentId` as request
   header or body field. No auth boundary.
7. **Renaming cost.** Resolved: deferred (see §10.1). MVP keeps
   `agent-spaces` and `@lherron/agent-spaces`.

## 13. Out-of-scope reminders

Do not, in this MVP:
- Implement `code_feature_tdd` preset (beyond stubbing as an escalation
  target).
- Build gateway ingress (Discord, email, etc.).
- Build a conversation-surface UI.
- Add scheduling (`Job` / `JobRun`).
- Build a richer waiver-governance or approval workflow beyond explicit
  waiver evidence attached to transitions.
- Migrate or port data from the old `agent-control-plane` repo.
- Do role-specific SOUL.md / HEARTBEAT.md overlays. The GuidancePacket
  carries role-specific agentHints, which is sufficient.
- Implement delivery (`DeliveryRequest`, `DeliveryTarget`). Outputs land
  in task evidence and stdout.

## 14. Definition of done

- `wrkq touch --project demo inbox/bug -t "Test defect"` creates a task
  that is then promoted (via ACP CLI or a wrkq intake hook) to
  `workflowPreset=code_defect_fastlane`, `presetVersion=1`,
  `riskClass=medium`. The demonstrated happy path uses distinct
  `implementer` and `tester` agent ids so the handoff path is visible.
- Running `acp task show --task <t>` renders a GuidancePacket with the
  current phase's objective, required evidence, and hints.
- Executing the full `open → red → green → verified → completed`
  sequence via the CLI succeeds with the required evidence attached at the
  red/green/verified gates; close-out provenance is recommended rather than
  mandatory.
- Attempting `green → verified` with the implementer's agentId is
  rejected with an SoD error.
- The `red → green` transition (when it declares a tester handoff)
  atomically writes one CoordinationEvent, one Handoff (state=open), and
  one WakeRequest (state=queued), all linked by `sourceEventId` /
  `taskId`.
- The tester's agent run (launched via HRC through ASP) receives
  `HRC_TASK_*` env vars matching its current phase (`green`) and role
  (`tester`), and the system prompt renders a "Current task context" block
  from them.
- The 6 regression tests ported from the old ACP pass.
- The 11 coordination-substrate contract tests pass.
- The end-to-end integration test in §10.10 passes.

---

**Start here:** read §0 (planning resolutions) first, then the rest of this
file, then `../acp-spec/spec/orchestration/TASK_WORKFLOWS.md` (especially
§2.2, §5.2, §6), and `../acp-spec/spec/orchestration/COORDINATION_SUBSTRATE.md`
(especially §5-8). §12 is already resolved — no need to gather more answers
from the user before starting.

**Suggested dispatch order.**
- §10.2 (wrkq schema proposal to `cody@wrkq` / `clod@wrkq`) — blocks §10.3.
  Start this first.
- §10.4, §10.5, §10.6 — can run in parallel; pure TS, no wrkq dependency.
- §10.3 (wrkq-lib) — runs once wrkq ships the schema.
- §10.7, §10.8, §10.9, §10.10, §10.11 — sequential after deps land.
