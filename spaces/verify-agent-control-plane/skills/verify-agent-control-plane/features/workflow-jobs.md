# Workflow, effects and jobs

## Sub-features

Task transitions, participant runs, evidence/obligations, actions, effects, scheduled jobs and job runs.

Source anchors (repo-relative): packages/acp-core/src/index.ts; packages/acp-server/src/jobs; tests/conformance/acp-workflow. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp action []`
- Surface: `cli:acp action triage [--actor --force --json --server]`
- Surface: `cli:acp job []`
- Surface: `cli:acp job create [--actor --agent --cron --disabled --in --input --job --json --lane-ref --project --scope-ref --server --table]`
- Surface: `cli:acp job list [--actor --json --project --server --table]`
- Surface: `cli:acp job patch [--actor --cron --disabled --enabled --in --input --job --json --server --table]`
- Surface: `cli:acp job run [--actor --job --json --poll-interval --server --table --timeout --wait]`
- Surface: `cli:acp job show [--actor --job --json --server --table]`
- Surface: `cli:acp job validate [--actor --in --json --server --table]`
- Surface: `cli:acp job-run []`
- Surface: `cli:acp job-run list [--actor --job --json --project --server --table]`
- Surface: `cli:acp job-run show [--actor --job-run --json --project --results --server --steps --table]`
- Surface: `cli:acp job-run wait [--actor --job-run --json --poll-interval --project --server --table --timeout]`
- Surface: `cli:acp task []`
- Surface: `cli:acp task evidence []`
- Surface: `cli:acp task evidence add [--actor --as --from-run --idempotency-key --json --kind --participant-run-id --ref --role --run-id --server --summary --supervisor-run --supervisor-run-id --task]`
- Surface: `cli:acp task obligation []`
- Surface: `cli:acp task obligation cancel [--actor --idempotency-key --json --obligation --reason --server --task]`
- Surface: `cli:acp task obligation waive [--actor --evidence-ref --idempotency-key --json --obligation --reason --server --task]`
- Surface: `cli:acp task run [--actor --agent --as --generation --harness --host-session-id --hrc-run-id --idempotency-key --json --lane-ref --launch-id --launch-runtime --resume --role --runtime-id --scope-ref --server --task]`
- Surface: `cli:acp task run-complete [--actor --as --evidence-ref --idempotency-key --json --outcome --run --server --summary]`
- Surface: `cli:acp task show [--actor --json --role --server --task]`
- Surface: `cli:acp task timeline [--actor --hrc-all-kinds --hrc-anchor --hrc-detail --hrc-event-window --hrc-kinds --hrc-store --json --markdown --no-color --no-hrc --only --plain --rejections-only --server --since --skip --task --until --verbose --width]`
- Surface: `cli:acp task transition [--actor --as --context-hash --evidence --evidence-ref --expected-version --idempotency-key --json --role --run --server --task --transition --waiver-ref]`
- Surface: `package:acp-core`
- Surface: `package:acp-e2e`
- Surface: `route:GET /v1/admin/jobs @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/jobs/:jobId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/jobs/:jobId/detail @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/jobs/scheduler @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/job-runs/:jobRunId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/jobs/:jobId/runs @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/pbc/jobs/:jobId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/pbc/tasks/:taskId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/tasks/:taskId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/wrkf/pbc/tasks/:task/inspect @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/wrkf/ping @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/wrkq/tasks @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/wrkq/tasks/:taskId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:PATCH /v1/admin/jobs/:jobId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/admin/jobs @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/jobs/:jobId/run @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/admin/jobs/validate @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/pbc/tasks/:taskId/continue @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/pbc/tasks/:taskId/dispose @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/pbc/tasks/:taskId/effects/reconcile @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/pbc/tasks/:taskId/input @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/pbc/tasks/:taskId/start @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/tasks/:taskId/evidence @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/tasks/:taskId/obligations/:obligationId/cancel @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/tasks/:taskId/obligations/:obligationId/satisfy @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/tasks/:taskId/obligations/:obligationId/waive @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/tasks/:taskId/transitions @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/workflow-interact-runs @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/workflow-participant-runs @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/workflow-participant-runs/:runId/complete @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/workflow-participant-runs/:runId/fail @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/wrkf/actions/launch @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/wrkf/effects/deliver @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/wrkf/pbc/tasks/:task/approve-transition @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/wrkf/pbc/tasks/:task/run-step @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/wrkf/pbc/tasks/:task/run-until-blocked @ packages/acp-server/src/routing/param-routes.ts`

## How to get to it

Discover `bun scripts/discover-acp.ts routes workflow` and `acp task --help`, `acp job --help`, `acp job-run --help`. Consult docs/ACP_JOBS_TASKS_USAGE.md for authoring; do not apply its live examples.

## Driving it

Run `bun test tests/conformance/acp-workflow` for source conformance. The full owned `just verify` runs package integration suites with ephemeral state. A manual end-to-end transition or job drive additionally needs scratch wrkf ledger, explicit actor/project/task and inert effects; until configured, report undriven.

## Gotchas

Source conformance includes state-machine failure cases but is not installed job dispatch proof. Never load production schedules, managed resources, hooks, or job recipients into scratch. No live scheduler substitution.

## Proven when

For a future drive, capture transition before/after plus rejected invalid transition, durable event ids and isolated job run/step outcomes. Current manual coverage is source-only, with no scheduler or real-agent execution claim.
