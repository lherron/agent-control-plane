# Agent Control Plane Current Spec

Updated: 2026-06-07

Status: current implementation spec for this repository. This document describes
what is present in `agent-control-plane` now, not the final target of the
Canonical Workflow Refactor drafts.

## Purpose

ACP is the control-plane layer between operator/gateway surfaces, HRC runtime
execution, wrkf workflow authority, and local SQLite-backed projections.

ACP owns:

- HTTP and CLI facades for agents, projects, sessions, jobs, gateways, mobile,
  deliveries, and workflow execution helpers.
- HRC launch, session resolution, input admission, run records, dispatch
  fencing, delivery targets, and dashboard projections.
- Local admin/interface/conversation/jobs/coordination/state stores needed for
  ACP operation and projections.

ACP does not own canonical wrkf workflow truth for current task lifecycle HTTP
routes. The remaining `/v1/tasks/:taskId` workflow routes are wrkf-backed
facades. The old `acp-core` in-memory workflow kernel still exists for package
tests, conformance coverage, presets, learning traces, and historical surfaces;
do not treat its presence as proof that ACP server task routes are currently
ACP-authoritative.

## Packages

- `acp-core`: shared domain types, presets, old workflow kernel, learning tools,
  validators, and webhook helpers.
- `acp-state-store`: SQLite repositories for ACP runtime state, run records,
  input admission/queue state, old workflow snapshots, and transition outbox
  rows.
- `acp-admin-store`: SQLite repositories for agents, projects, memberships,
  profiles, heartbeats, and system events.
- `acp-interface-store`: interface bindings, identities, message sources, and
  delivery-related records.
- `acp-conversation`: conversation threads and turns.
- `acp-jobs-store`: scheduled jobs, job runs, cron/flow records.
- `acp-server`: Bun HTTP server, route handlers, dispatchers, wrkf lifecycle,
  HRC launch bridge, and reconcilers.
- `acp-cli`: installed `acp` operator CLI for server, admin, sessions, runs,
  tasks, jobs, delivery, and conversation inspection.
- `gateway-discord`: Discord gateway embedded through `acp server restart` in
  the dev stack.
- `gateway-ios`: mobile gateway surface.
- `acp-ops-projection`, `acp-ops-reducer`, `acp-viewer`: dashboard/viewer
  contracts and apps. Older docs mention `acp-ops-web`, but no tracked
  `packages/acp-ops-web/package.json` is present in this checkout.
- `coordination-substrate`: coordination ledger.
- `wrkq-lib`: TypeScript access to wrkq SQLite state.
- `wlearn`: workflow-learning trace/replay CLI helpers.

## Runtime And Config

The installed `acp` CLI defaults to `http://127.0.0.1:18470`.

The launchd-managed ACP server uses:

- plist source: `launchd/com.praesidium.acp-server.plist`
- HTTP endpoint: `http://127.0.0.1:18470`
- logs: `/Users/lherron/praesidium/var/logs/acp-server.{log,err.log}`
- state DBs: `/Users/lherron/praesidium/var/db/acp-*.db`

Server CLI/environment options include:

- `ACP_WRKQ_DB_PATH` or `WRKQ_DB_PATH`: required wrkq database path.
- `ACP_COORD_DB_PATH`: coordination DB, default
  `/Users/lherron/praesidium/var/db/acp-coordination.db`.
- `ACP_INTERFACE_DB_PATH`: interface DB, default
  `/Users/lherron/praesidium/var/db/acp-interface.db`.
- `ACP_STATE_DB_PATH`: ACP state DB, default
  `/Users/lherron/praesidium/var/db/acp-state.db`.
- `ACP_ADMIN_DB_PATH`, `ACP_JOBS_DB_PATH`, `ACP_CONVERSATION_DB_PATH`: optional
  sibling DB overrides.
- `ACP_AGENT_ASSETS_DIR`: profile assets directory, default
  `/Users/lherron/praesidium/var/state/acp-server/assets/agents`.
- `ACP_HOST`, `ACP_PORT`, `ACP_ACTOR`: server bind and default actor.
- `WRKF_BIN`: wrkf executable, default `wrkf`.
- `WRKF_DB_PATH`: wrkf DB, defaulting to the ACP wrkq DB path.
- `ACP_WRKF_DISABLED=1|true`: bypass wrkf startup for local dev/test.
- Dispatcher/scheduler knobs:
  `ACP_SCHEDULER_ENABLED`,
  `ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS`,
  `ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS`,
  `ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS`.

`/v1/wrkf/ping` reports whether the server has a live wrkf port:
`{"wrkf":"available"}` or `{"wrkf":"unavailable"}`.

## Workflow Boundary

Current route behavior:

- `GET /v1/tasks/:taskId` calls wrkf `task.inspect`, `task.timeline`, `next`,
  `evidence.list`, `obligation.list`, `effect.list`, and `run.list`, then
  returns `{ source: "wrkf", task, instance, next, timeline, evidence,
  obligations, effects, runs }`.
- `POST /v1/tasks/:taskId/transitions` delegates to wrkf `transition.apply`.
  ACP maps legacy `expectedTaskVersion` to wrkf `expectRevision`, passes
  `contextHash`, `checkIds`, `runChecks`, `dryRun`, and `idempotencyKey`, then
  triggers a wrkf effect-delivery tick for non-dry-run mutations.
- `POST /v1/tasks/:taskId/evidence` delegates to wrkf `evidence.add`. ACP keeps
  compatibility with older CLI bodies but only sends wrkf fields: `task`,
  `kind`, `ref`, `actor`, optional `summary`, optional `facts`, and optional
  `role`.
- Obligation waive/cancel routes delegate to wrkf `obligation.waive` and
  `obligation.cancel`.
- `POST /v1/workflow-participant-runs` starts a wrkf run, launches HRC through
  ACP's role-scoped launcher, stores ACP execution metadata in the run store,
  and binds external HRC metadata back to wrkf.
- Participant run completion/failure routes delegate to wrkf `run.finish` and
  `run.fail`.

The wrkf boundary lives in `packages/acp-server/src/wrkf/`:

- `client-lifecycle.ts`: starts one long-lived `@wrkf/client` process and
  initializes JSON-RPC over stdio.
- `port.ts`: ACP-local TypeScript surface for wrkf methods.
- `errors.ts`: maps wrkf domain errors to HTTP statuses.
- `participant-launch.ts`: wrkf run start/replay, ACP run-store correlation,
  HRC launch, and external bind.

## Sessions, Runs, And Inputs

Session selectors are `SessionRef` values from `agent-scope`, with a scope ref
and lane ref. Common scope refs look like:

- `agent:<agentId>`
- `agent:<agentId>:project:<projectId>:task:<taskId>`

ACP resolves sessions through HRC and stores local run metadata for dispatch
fencing, outbound messages, attachments, active-run contribution reconciliation,
and wrkf launch correlation. This state is execution metadata, not workflow
truth.

Inputs enter through `/v1/inputs`, interface messages, mobile messages, job
dispatch steps, or gateway bindings. The input admission path records attempts,
queue/apply state, session admission sequence, and stale/lease behavior in the
ACP state store.

## CLI Surfaces

Use `acp --help` and subcommand help as the source of truth for flags. The
current installed task commands are:

- `acp task show`
- `acp task timeline`
- `acp task transition`
- `acp task run`
- `acp task run-complete`
- `acp task evidence add`
- `acp task obligation waive`
- `acp task obligation cancel`

Other current command families include admin/interface binding management,
agents, projects, memberships, runtime/session/run inspection, `send`, `tail`,
`render`, coordination messages, jobs, heartbeats, delivery retries, threads,
and server lifecycle.

## Persistence And Concurrency

SQLite stores are split by concern rather than by package ownership alone:

- wrkq/wrkf DB: task/workflow authority owned by wrkq/wrkf.
- ACP state DB: run records, input admission/queue records, old workflow
  snapshots, and runtime metadata.
- ACP admin DB: agents, projects, memberships, heartbeats, system events,
  profiles.
- ACP interface DB: bindings, identities, message sources, delivery metadata.
- ACP coordination DB: coordination messages and handoff/wake-related substrate.
- ACP jobs DB: jobs and job runs.
- ACP conversation DB: threads and turns.

Idempotency and concurrency rules are source-specific:

- wrkf owns workflow mutation idempotency, stale revision checks, effect leases,
  and canonical transition legality.
- ACP owns input admission leases, run dispatch fences, delivery retries, and
  HRC launch correlation.
- ACP must not persist wrkf projections as durable workflow truth.

## Documentation Set

Keep as current operator/package docs:

- `AGENTS.md` and `CLAUDE.md`: agent-facing operational instructions.
- `packages/*/README.md` and package-local smoke docs.
- `tests/conformance/acp-workflow/README.md`: conformance suite guide.
- `scenarios/flow-presets/**/runbook.md`: scenario runbooks.
- `docs/acp-supervisor-playbook.md` and
  `docs/acp-workflow-verification.md`: historical/current workflow-kernel
  verification material tied to conformance tests.

Treat as historical or migration material unless current source says otherwise:

- `heuristic-learning-acp-hrc-spec.md`
- `HEURISTIC_LEARNING_IMPLEMENTATION.md`
- `HEURISTIC_LEARNING_E2E_RUNBOOK.md`
- `HRC_SPLIT_IMPL.md`
- `GBRAIN_IMPL.md`
- `specs/archived/**`
- `specs/acp-task-timeline-cli.md`
- `specs/acp-task-timeline-with-hrc.md`
- `specs/spec_agent_spaces.md` (external ASP contract material)

Untracked drafts observed during this cleanup:

- `CANONICAL_WORKFLOW_REFACTOR.md`
- `PBC_HARNESS.md`

They describe target refactor direction and should not be treated as current
implementation until source and installed behavior match them.

## Known Limits

- Current docs still include historical workflow-kernel runbooks that are useful
  for conformance and learning tests but do not describe the wrkf-backed server
  task routes.
- `acp-core` still exports the old in-memory workflow kernel while server task
  lifecycle routes use wrkf. This is a transitional architecture.
- Some CLI compatibility flags remain accepted even when the wrkf-backed server
  route ignores the corresponding old ACP-kernel field.
- Discord gateway changes require real Discord smoke validation; fake clients
  are not sufficient for completion claims.
