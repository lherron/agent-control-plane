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

- `ACP_WRKQ_DB` or `WRKQ_DB`: canonical wrkq locator, accepting either a local
  path or an authenticated `rpc://` wrkqd endpoint. `ACP_WRKQ_DB` has precedence.
- `ACP_WRKQ_DB_PATH` or `WRKQ_DB_PATH`: legacy path-only compatibility inputs;
  `rpc://` values are rejected. CLI/environment precedence is `--wrkq-db`,
  `--wrkq-db-path`, `ACP_WRKQ_DB`, `WRKQ_DB`, `ACP_WRKQ_DB_PATH`, then
  `WRKQ_DB_PATH`.
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
- `WRKF_HOOK_CATALOG`: required wrkf hook-catalog path. The launchd-managed
  server uses `config/wrkf-hook-catalog.json`, an explicit empty v0 catalog;
  deployments that need hooks replace that file with their managed catalog.
- `ACP_WRKF_DISABLED=1|true`: bypass wrkf startup for local dev/test.
- Dispatcher/scheduler knobs:
  `ACP_SCHEDULER_ENABLED`,
  `ACP_EVENT_CAUSATION_DEPTH_LIMIT` (default `8`; event-hook ancestry walks
  beyond this are recorded as `causation_depth` skips),
  `ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS`,
  `ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS`,
  `ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS`.

`/v1/wrkf/ping` reports whether the server has a live wrkf port:
`{"wrkf":"available"}` or `{"wrkf":"unavailable"}`.

## Workflow Boundary

Current route behavior:

- `GET /v1/wrkq/tasks` is the read-only wrkq board feed. It calls the existing
  `wrkq.task.list` port with summary mode forced on and returns
  `{ tasks, nextCursor }`; task rows contain only `id`, `title`, `state`,
  `priority`, `kind`, `path`, derived project slug, and `updatedAt`. Optional
  native filters are `project` (root path, recursive by default), `path`,
  repeatable or comma-separated `state`, `limit` (default `100`, maximum `200`),
  `sort`, `direction`, `recursive`, and `cursor`. The default ordering is
  `updated_at desc`. This route is distinct from the wrkf-backed workflow routes
  below and exposes no mutation surface.
- `GET /v1/wrkq/tasks/:taskId` is the read-only wrkq task-inspector feed. It
  requires a canonical `T-<digits>` id, calls the typed `wrkq.task.show`,
  `wrkq.comment.list`, and `wrkq.relation.list` client facades, and returns
  `{ task, comments, relations }`. `comments` defaults to the latest `5`, accepts
  `0...25`, and is collected through the canonical ascending cursor so the
  facade does not depend on the CLI compatibility projection. The task body,
  ownership, claim, schedule, workflow metadata, outcome, comments and
  relations are read projections only; this route exposes no mutation surface.
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

## Event Webhooks And Jobs

ACP has one canonical event webhook envelope, `AcpWebhookEvent`, defined in
`acp-core`. `POST /v1/webhooks/events` accepts this normalized v1 envelope:

```json
{
  "schema_version": 1,
  "source": "media-ingest",
  "event_id": "evt_123",
  "event_seq": 123,
  "event": "transcript.completed",
  "occurred_at": "2026-06-13T00:00:00Z",
  "origin": { "actor": "system:media-ingest", "kind": "system" },
  "subject": { "type": "transcript", "id": "tr_123" },
  "payload": { "backend": "mlx" }
}
```

`POST /v1/webhooks/wrkq` remains a compatibility adapter for wrkq v2 payloads.
It validates the wrkq shape, adapts it into `AcpWebhookEvent`, and stores the
normalized payload. Scheduler evaluation reads the normalized model; it must not
assume inbox payloads are wrkq-only.

HRC is a canonical producer on `POST /v1/webhooks/events`. Its rev3 envelope
uses `source: "hrc"`, `<nodeId>:<tripEventSeq>` as `event_id`, the HRC ledger
sequence as `event_seq`, the HRC reason code as `event` (`first_turn_missing`
first), and the HRC-recorded timestamp as `occurred_at`. Qualifying the
producer-local trip sequence with the logical HRC node id prevents two nodes
sharing this listener from colliding on the durable `source:event_id` inbox key.
It always carries both:

- `subject: { "type": "hrc-runtime", "id": "<runtimeId>" }`, which gives
  cooldowns the per-runtime target key `hrc-runtime:<runtimeId>`;
- `origin`, recording the initiating principal and kind, with
  `origin.causation_ref` set to the bare ACP job-run id for a job-created
  dispatch. Unknown principals use `system:hrc` / `system`.

The HRC payload contains only the pointer fields `nodeId`, `runtimeId`,
`scopeRef`, `generation`, `invocationId`, `runId`, `tripEventId`, and
`retrievalHint`. It never contains pane text, argv, or prompt material.
`tripEventId` remains the node-local sequence used for retrieval;
`retrievalHint` is producer-built and consumers use it verbatim. Since real HRC
trips are commonly agent-initiated and the event-job default denies agent
origins, a job intended to observe those trips must declare an explicit
`originPolicy`; causation-cycle and depth checks still run afterward.

The bridge is activated only for the ACP-co-resident HRC node declared by HRC
configuration authority in v1.
Before dispatch, the built-in `hrc-first-turn-missing-notify` job's in-process
flow probe compares `payload.nodeId` with ACP's HRC-backed job execution
identity. A mismatch or unavailable identity logs a warning and completes as a
no-op, so future cross-node enablement cannot silently execute against the wrong
node. The comparison never derives node identity from a hostname or IP address.

The wrkq v2 adapter keeps the producer payload and the Discord/system-events
renderer contract separate. Minimal v2 payloads still require only
`schema_version: 2`, `event_id`, `event_seq`, and `event`; current wrkq
`changed`/`changes` maps may contain non-renderer keys and remain valid. When
recognized enrichment objects are present, ACP validates their shape
fail-closed before any observer append or jobs-inbox write:

- `comment`: optional `id`, `author`, `preview`, and raw producer fields.
- `move`: optional `from_container_path` and `to_container_path`.
- `archive`: optional `prior_state`, `prior_container_path`, `reason`, and
  `note`.
- `workflow`: compact identity, state, transition, action/run, role,
  next-action, obligation, and check summary fields.

The system-events projection for wrkq/wrkf lifecycle events is explicit and
bounded. It preserves only existing card identity/context fields plus safe
optional summaries for `wrkq.comment_added`, `wrkq.moved`, `wrkq.archived`,
`wrkq.purged`, `wrkq.updated`, `wrkf.workflow_attached`, and
`wrkf.workflow_transitioned`. Comment previews, archive reasons/notes, compact
labels, and compact arrays are sanitized/truncated; raw comment bodies,
descriptions, specifications, workflow payloads, evidence, check output, and
arbitrary producer blobs are never emitted to system-events. The jobs inbox still
stores the normalized webhook event for audit/replay.

Webhook ingest is durable and idempotent by `(source,event_id)`. The current
SQLite key is the canonical string `source:event_id`, so producer-local ids from
different sources cannot suppress each other. Producer `event_seq` is
source-local provenance, not a cross-source total order. The current inbox drain
orders by `event_seq`, but correctness must not depend on global ordering across
sources.

Event jobs use `trigger.kind = "event"` and must declare `trigger.source`.
Evaluation first compares `trigger.source` to the normalized event `source`.
Only then are match predicates evaluated. Supported match predicates are:

- `event`: string or string array.
- `subject.type`: string or string array, represented as
  `{ "subject": { "type": "transcript" } }`.
- wrkq compatibility fields: `transition`, `project_scope_id`,
  `container_path`, `labels`, and `kind`, evaluated against the normalized
  event payload.
- `origin.actor` and `origin.kind`.
- `payload` path predicates using dot-separated paths with up to eight segments,
  for example `{ "payload": { "backend": { "eq": "mlx" } } }`. Each predicate
  supports deterministic `eq`, `anyOf`, and `exists` over JSON scalar values.
  Arbitrary expressions are not supported.

Event-triggered jobs still dispatch through the existing input path and may not
be broadened into multi-step `flow` jobs. The action snapshot is resolved before
minting a `JobRun`; dispatch consumes the resolved snapshot on the `JobRun`, not
live templated job fields.

Authority-bearing templates fail closed. `scopeRef` and `laneRef` templates can
use only explicit structural variables allowlisted per source. v1 allows wrkq
`project_scope_id` and `ticket_id` for compatibility and denies payload-derived
structural variables for other sources. Generic event jobs should use static
scope/lane targets unless ACP adds a source-specific structural allowlist.
Payload values may be interpolated only into input/prompt content through
`{{payload.path}}`, with per-field and total-size caps plus control-character
sanitization. Unknown or missing variables fail the job match as a template
error.

Cooldowns use a deterministic `targetKey`, stored in the existing
`target_task_id` column until that schema name is renamed. For wrkq the target
key is `ticket_id`; for generic events it is `subject.type:subject.id` when
present, otherwise the canonical event id. This prevents cooldowns from becoming
silently inoperative for generic producers.

Both webhook routes are loopback-trusted only for v1. They are not internet-safe
without source authentication/signing.

Job lifecycle system-events (`job.dispatched` and `job.completed`) include
available `JobRunRecord` timing fields: `triggeredAt`, `claimedAt`,
`dispatchedAt`, and `completedAt`. Terminal events include `durationMs` only
when `triggeredAt` and `completedAt` parse as valid timestamps and completion is
not earlier than trigger time.

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
