# CLI and administration

## Sub-features

Commander commands, actors, projects, memberships, managed resources, identities, heartbeats and system events.

Source anchors (repo-relative): packages/acp-cli/src/cli.ts; packages/acp-server/src/handlers/admin-projects.ts. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp [--actor --json --server]`
- Surface: `cli:acp admin []`
- Surface: `cli:acp admin contributions []`
- Surface: `cli:acp admin contributions reconcile [--actor --all-pending --input-application-id --json --server]`
- Surface: `cli:acp admin managed-resource []`
- Surface: `cli:acp admin managed-resource apply [--actor --in --json --server]`
- Surface: `cli:acp admin managed-resource reconcile [--actor --in --json --server --source-deletion]`
- Surface: `cli:acp admin managed-resource status [--actor --in --json --server]`
- Surface: `cli:acp agent []`
- Surface: `cli:acp agent create [--actor --agent --display-name --home-dir --json --server --status]`
- Surface: `cli:acp agent list [--actor --json --server]`
- Surface: `cli:acp agent patch [--actor --agent --display-name --home-dir --json --server --status]`
- Surface: `cli:acp agent show [--actor --agent --json --server]`
- Surface: `cli:acp agent-pulpit []`
- Surface: `cli:acp agent-pulpit send [--actor --agent --binding --gateway-type --idempotency-key --json --lane-ref --project --server --text]`
- Surface: `cli:acp heartbeat []`
- Surface: `cli:acp heartbeat set [--actor --agent --json --lane --note --scope --server --source]`
- Surface: `cli:acp heartbeat wake [--actor --agent --json --lane --reason --scope --server]`
- Surface: `cli:acp membership []`
- Surface: `cli:acp membership add [--actor --agent --json --project --role --server]`
- Surface: `cli:acp membership list [--actor --json --project --server]`
- Surface: `cli:acp message []`
- Surface: `cli:acp message broadcast [--actor --coordination-only --dispatch --from-agent --from-human --from-lane-ref --from-session --from-system --json --project --server --table --text --to-agent --to-human --to-lane-ref --to-session --to-system --wake]`
- Surface: `cli:acp message send [--actor --coordination-only --dispatch --from-agent --from-human --from-lane-ref --from-session --from-system --json --project --server --table --text --to-agent --to-human --to-lane-ref --to-session --to-system --wake]`
- Surface: `cli:acp project []`
- Surface: `cli:acp project create [--actor --display-name --home-dir --json --project --root-dir --server]`
- Surface: `cli:acp project default-agent [--actor --agent --json --project --server]`
- Surface: `cli:acp project list [--actor --json --server]`
- Surface: `cli:acp project show [--actor --json --project --server]`
- Surface: `cli:acp run []`
- Surface: `cli:acp run cancel [--actor --json --project --run --server --table]`
- Surface: `cli:acp run show [--actor --json --project --run --server --table]`
- Surface: `cli:acp runtime []`
- Surface: `cli:acp runtime resolve [--actor --json --lane-ref --project --scope-ref --server --table]`
- Surface: `cli:acp send [--actor --contribution-fallback --contribution-semantics --idempotency-key --intent --json --lane-ref --meta --no-dispatch --project --scope-ref --server --table --text --wait --wait-interval-ms --wait-timeout-ms]`
- Surface: `cli:acp session []`
- Surface: `cli:acp session attach-command [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session capture [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session interrupt [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session list [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session reset [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session resolve [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session runs [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp session show [--actor --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `cli:acp system-event []`
- Surface: `cli:acp system-event list [--actor --json --kind --occurred-after --occurred-before --project --server]`
- Surface: `cli:acp system-event push [--actor --json --kind --occurred-at --payload --project --server]`
- Surface: `package:acp-cli`
- Surface: `package:acp-server`
- Surface: `route:GET /admin/agents @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/agents @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/agents/:agentId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/agents/:agentId/detail @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/agents/:agentId/heartbeat @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/agents/:agentId/system-prompt @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/deployment-coherence @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/memberships @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/projects @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/admin/projects/:projectId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/projects/:projectId/detail @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/projects/:projectId/memberships @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/admin/system-events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/assets/agents/:agentId/pfp.png @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/input-attempts/:inputAttemptId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/runs/:runId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/session-refs/events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/sessions @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/sessions/:sessionId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/sessions/:sessionId/attach-command @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/sessions/:sessionId/capture @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/sessions/:sessionId/events @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/sessions/:sessionId/runs @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/wrkq/projects/:project/timeline @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:PATCH /v1/admin/agents/:agentId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:PATCH /v1/admin/agents/:agentId/profile @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /admin/agents/:agentId/inspect @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/admin/agents @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/agents/:agentId/heartbeat/wake @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/admin/contributions/reconcile @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/managed-resources/apply @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/managed-resources/reconcile @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/managed-resources/status @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/memberships @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/projects @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/admin/projects/:projectId/default-agent @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/admin/system-events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/agent-pulpit/messages @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/coordination/messages @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/inputs @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/messages @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/runs/:runId/cancel @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/runtime/resolve @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/sessions/:sessionId/interrupt @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/sessions/launch @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/sessions/reset @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/sessions/resolve @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/webhooks/events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/webhooks/wrkq @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:PUT /v1/admin/agents/:agentId/heartbeat @ packages/acp-server/src/routing/param-routes.ts`

## How to get to it

Use `acp --help` and `acp project --help` for installed syntax. The scratch helper uses explicit `--server`, `--actor verify-scratch`, and `--project verify-scratch-<pid>` to create then read a project.

## Driving it

Run `bun scripts/verify-acp-scratch.ts` inside the owned environment (see SKILL.md). Inspect `wire-shapes`, `project-create`, `project-show`, `project-conflict`, and missing-project HTTP records. The helper exercises source CLI over real HTTP; separately run installed `acp --help` to establish installed surface availability.

## Gotchas

Global CLI actor flags are not accepted by every command: `heartbeat set`, `heartbeat wake`, `interface identity register` and `system-event push` reject `--actor` with `unknown flag: --actor` (observed T-11918), as do several reads. Pass actor on the other mutations and server on each call. `membership add --role` accepts only coordinator, implementer, tester or observer; `system-event push` requires `--occurred-at`. Managed-resource apply, heartbeat wake, pulpit/message and send can start real work; they remain undriven unless isolated authority is demonstrated.

## Proven when

Create/read ids agree, conflicting create returns 409, missing project returns 404, and scratch DB stays under the owned root. This proves only project CRUD subset, not governance/identity/wake correctness.
