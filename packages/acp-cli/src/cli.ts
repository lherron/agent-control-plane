#!/usr/bin/env bun

import { CliUsageError, exitWithError, writeCommandOutput } from './cli-runtime.js'
import { runAdminInterfaceBindingDisableCommand } from './commands/admin-interface-binding-disable.js'
import { runAdminInterfaceBindingListCommand } from './commands/admin-interface-binding-list.js'
import { runAdminInterfaceBindingSetCommand } from './commands/admin-interface-binding-set.js'
import { runAgentCommand } from './commands/agent.js'
import { runDeliveryCommand } from './commands/delivery.js'
import { runHeartbeatCommand } from './commands/heartbeat.js'
import { runInterfaceIdentityCommand } from './commands/interface-identity.js'
import { runJobRunCommand } from './commands/job-run.js'
import { runJobCommand } from './commands/job.js'
import { runMembershipCommand } from './commands/membership.js'
import { runMessageCommand } from './commands/message.js'
import { runProjectCommand } from './commands/project.js'
import { runRenderCommand } from './commands/render.js'
import { runRunCommand } from './commands/run.js'
import { runRuntimeCommand } from './commands/runtime.js'
import { runSendCommand } from './commands/send.js'
import { runSessionCommand } from './commands/session.js'
import type { CommandDependencies } from './commands/shared.js'
import { runSystemEventCommand } from './commands/system-event.js'
import { runTailCommand } from './commands/tail.js'
import { runTaskCreateCommand } from './commands/task-create.js'
import { runTaskEvidenceAddCommand } from './commands/task-evidence-add.js'
import { runTaskPromoteCommand } from './commands/task-promote.js'
import { runTaskShowCommand } from './commands/task-show.js'
import { runTaskTransitionCommand } from './commands/task-transition.js'
import { runTaskTransitionsCommand } from './commands/task-transitions.js'
import { runThreadCommand } from './commands/thread.js'
import { runServerCommand } from './server-runtime.js'

function renderTopLevelHelp(): string {
  return [
    'Usage:',
    '  acp <command> [options]',
    '',
    'Commands:',
    '  agent         Manage ACP agents',
    '  admin         Manage ACP admin bindings',
    '  delivery      Retry or inspect failed deliveries',
    '  heartbeat     Set agent heartbeats or trigger wake requests',
    '  interface     Manage interface identities',
    '  job           Manage scheduled jobs',
    '  job-run       Inspect job runs',
    '  membership    Manage project memberships',
    '  message       Send coordination messages',
    '  project       Manage ACP projects',
    '  render        Replay-derived render (or capture snapshot with --source capture)',
    '  run           Inspect or cancel ACP runs',
    '  runtime       Resolve runtime placement',
    '  send          Send an input into a session',
    '  server        Manage the ACP HTTP server and Discord gateway process',
    '  session       Resolve and control sessions',
    '  system-event  Append or list system events',
    '  tail          Live-stream session events incrementally',
    '  task          Manage ACP workflow tasks',
    '  thread        Inspect conversation threads',
    '',
    'Environment:',
    '  ACP_SERVER_URL        ACP server base URL (default: http://127.0.0.1:18470)',
    '  ACP_ACTOR_AGENT_ID    Default actor id for write commands',
  ].join('\n')
}

function renderSimpleHelp(input: {
  usage: string
  summary: string
  example?: string | undefined
  options?: string[] | undefined
}): string {
  return [
    'Usage:',
    `  ${input.usage}`,
    '',
    input.summary,
    ...(input.options !== undefined && input.options.length > 0
      ? ['', 'Options:', ...input.options.map((option) => `  ${option}`)]
      : []),
    ...(input.example !== undefined ? ['', 'Example:', `  ${input.example}`] : []),
  ].join('\n')
}

function renderTaskHelp(): string {
  return renderSimpleHelp({
    usage: 'acp task <create|promote|show|evidence|transition|transitions> [options]',
    summary: 'Create, inspect, and transition ACP workflow tasks.',
    example: 'acp task show --task T-01186 --json',
  })
}

function renderTaskCreateHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp task create --preset <id> --preset-version <n> --risk-class <low|medium|high> --project <projectId> --role implementer:<agentId> [options]',
    summary: 'Create a preset-driven ACP workflow task.',
    example:
      'acp task create --preset code_defect_fastlane --preset-version 1 --risk-class medium --project agent-spaces --role implementer:larry --actor clod',
    options: [
      '--role <role>:<agentId>   Repeatable role assignment',
      '--actor <agentId>',
      '--kind <task|bug|spike|chore>',
      '--meta <json>',
      '--server <url>',
      '--json',
    ],
  })
}

function renderTaskShowHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp task show --task <T-XXXXX> [--role <role>] [--actor <agentId>] [--server <url>] [--json]',
    summary: 'Show task state and role-scoped task context.',
    example: 'acp task show --task T-01186 --role implementer --json',
  })
}

function renderTaskPromoteHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp task promote --task <T-XXXXX> --preset <id> --preset-version <n> --risk-class <low|medium|high> --role implementer:<agentId> [options]',
    summary: 'Promote a wrkq task into ACP workflow control.',
    example:
      'acp task promote --task T-01186 --preset code_defect_fastlane --preset-version 1 --risk-class medium --role implementer:larry --actor clod',
    options: [
      '--role <role>:<agentId>   Repeatable role assignment',
      '--actor <agentId>',
      '--actor-role <role>',
      '--initial-phase <phase>',
      '--server <url>',
      '--json',
    ],
  })
}

function renderTaskEvidenceHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp task evidence add --task <T-XXXXX> --kind <kind> --ref <ref> --producer-role <role> [options]',
    summary: 'Attach evidence items to a task.',
    example:
      'acp task evidence add --task T-01186 --kind test_log --ref file://results.txt --producer-role tester --actor larry',
  })
}

function renderTaskTransitionHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp task transition --task <T-XXXXX> --to <phase> --actor-role <role> --expected-version <n> [options]',
    summary: 'Apply one ACP task phase transition.',
    example:
      'acp task transition --task T-01186 --to red --actor-role implementer --expected-version 1 --actor larry',
  })
}

function renderTaskTransitionsHelp(): string {
  return renderSimpleHelp({
    usage: 'acp task transitions --task <T-XXXXX> [--server <url>] [--json]',
    summary: 'List task transition history.',
    example: 'acp task transitions --task T-01186 --json',
  })
}

function renderAdminHelp(): string {
  return renderSimpleHelp({
    usage: 'acp admin interface binding <list|set|disable> [options]',
    summary: 'Manage ACP interface bindings.',
    example: 'acp admin interface binding list --gateway acp-discord-smoke --json',
  })
}

function renderAdminInterfaceHelp(): string {
  return renderSimpleHelp({
    usage: 'acp admin interface binding <list|set|disable> [options]',
    summary: 'List, set, or disable interface bindings.',
    example:
      'acp admin interface binding set --gateway discord --conversation-ref channel:123 --scope-ref agent:larry:project:agent-spaces',
  })
}

function renderAdminInterfaceBindingListHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp admin interface binding list [--gateway <id>] [--conversation-ref <ref>] [--thread-ref <ref>] [--project <projectId>] [--server <url>] [--json]',
    summary: 'List interface bindings by gateway, conversation, or project.',
    example:
      'acp admin interface binding list --gateway acp-discord-smoke --conversation-ref channel:123 --json',
  })
}

function renderAdminInterfaceBindingSetHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp admin interface binding set --gateway <id> --conversation-ref <ref> (--session <handle> | --scope-ref <scopeRef>) [options]',
    summary: 'Upsert one ACP interface binding.',
    example:
      'acp admin interface binding set --gateway discord --conversation-ref channel:123 --scope-ref agent:larry:project:agent-spaces --project agent-spaces',
    options: [
      '--thread-ref <ref>',
      '--project <projectId>',
      '--lane-ref <laneRef>',
      '--actor <agentId>',
      '--server <url>',
      '--json',
    ],
  })
}

function renderAdminInterfaceBindingDisableHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp admin interface binding disable --gateway <id> --conversation-ref <ref> [--thread-ref <ref>] [--server <url>] [--json]',
    summary: 'Disable one ACP interface binding.',
    example:
      'acp admin interface binding disable --gateway discord --conversation-ref channel:123 --json',
  })
}

function renderAgentHelp(): string {
  return renderSimpleHelp({
    usage: 'acp agent <create|list|show|patch> [options]',
    summary: 'Manage ACP admin agents.',
    example: 'acp agent list --json',
  })
}

function renderAgentCreateHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp agent create --agent <agentId> --status <active|disabled> [--display-name <name>] --actor <agentId> [options]',
    summary: 'Create one admin agent record.',
    example:
      'acp agent create --agent larry --display-name Larry --status active --actor clod --json',
  })
}

function renderAgentListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp agent list [--server <url>] [--json]',
    summary: 'List ACP admin agents.',
    example: 'acp agent list --json',
  })
}

function renderAgentShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp agent show --agent <agentId> [--server <url>] [--json]',
    summary: 'Show one ACP admin agent.',
    example: 'acp agent show --agent larry --json',
  })
}

function renderAgentPatchHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp agent patch --agent <agentId> [--display-name <name>] [--status <active|disabled>] --actor <agentId> [options]',
    summary: 'Patch an ACP admin agent.',
    example: 'acp agent patch --agent larry --display-name Larry --actor clod --json',
  })
}

function renderProjectHelp(): string {
  return renderSimpleHelp({
    usage: 'acp project <create|list|show|default-agent> [options]',
    summary: 'Manage ACP projects.',
    example: 'acp project list --json',
  })
}

function renderProjectCreateHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp project create --project <projectId> --display-name <name> --actor <agentId> [options]',
    summary: 'Create one ACP project.',
    example:
      'acp project create --project agent-spaces --display-name "Agent Spaces" --actor clod --json',
  })
}

function renderProjectListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp project list [--server <url>] [--json]',
    summary: 'List ACP projects.',
    example: 'acp project list --json',
  })
}

function renderProjectShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp project show --project <projectId> [--server <url>] [--json]',
    summary: 'Show one ACP project.',
    example: 'acp project show --project agent-spaces --json',
  })
}

function renderProjectDefaultAgentHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp project default-agent --project <projectId> --agent <agentId> --actor <agentId> [options]',
    summary: 'Set the default agent for a project.',
    example: 'acp project default-agent --project agent-spaces --agent larry --actor clod --json',
  })
}

function renderMembershipHelp(): string {
  return renderSimpleHelp({
    usage: 'acp membership <add|list> [options]',
    summary: 'Manage project memberships.',
    example: 'acp membership list --project agent-spaces --json',
  })
}

function renderMembershipAddHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp membership add --project <projectId> --agent <agentId> --role <role> --actor <agentId> [options]',
    summary: 'Add one project membership.',
    example:
      'acp membership add --project agent-spaces --agent larry --role implementer --actor clod --json',
  })
}

function renderMembershipListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp membership list --project <projectId> [--server <url>] [--json]',
    summary: 'List memberships for one project.',
    example: 'acp membership list --project agent-spaces --json',
  })
}

function renderInterfaceHelp(): string {
  return renderSimpleHelp({
    usage: 'acp interface identity register [options]',
    summary: 'Register interface identities.',
    example: 'acp interface identity register --gateway discord --external-id user:123 --json',
  })
}

function renderInterfaceIdentityRegisterHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp interface identity register --gateway <id> --external-id <ref> [--display-name <name>] [--linked-agent <agentId>] [options]',
    summary: 'Register one external interface identity.',
    example:
      'acp interface identity register --gateway discord --external-id user:123 --display-name Larry --json',
  })
}

function renderSystemEventHelp(): string {
  return renderSimpleHelp({
    usage: 'acp system-event <push|list> [options]',
    summary: 'Append or list admin system events.',
    example:
      'acp system-event push --project agent-spaces --kind task.updated --payload {"taskId":"T-01186"} --occurred-at 2026-04-23T00:00:00Z --json',
  })
}

function renderSystemEventPushHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp system-event push --project <projectId> --kind <kind> --payload <json> --occurred-at <iso8601> [options]',
    summary: 'Append one admin system event.',
    example:
      'acp system-event push --project agent-spaces --kind workflow.updated --payload {"taskId":"T-01186"} --occurred-at 2026-04-23T00:00:00Z --json',
  })
}

function renderSystemEventListHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp system-event list [--project <projectId>] [--kind <kind>] [--occurred-after <iso8601>] [--occurred-before <iso8601>] [options]',
    summary: 'List admin system events with optional filters.',
    example: 'acp system-event list --project agent-spaces --kind workflow.updated --json',
  })
}

function renderRuntimeHelp(): string {
  return renderSimpleHelp({
    usage: 'acp runtime resolve --scope-ref <scopeRef> [--lane-ref <laneRef>] [options]',
    summary: 'Resolve the runtime placement ACP would request.',
    example: 'acp runtime resolve --scope-ref agent:larry:project:agent-spaces --json',
  })
}

function renderSessionHelp(): string {
  return renderSimpleHelp({
    usage: 'acp session <resolve|list|show|runs|reset|interrupt|capture|attach-command> [options]',
    summary: 'Resolve, inspect, and control ACP sessions.',
    example: 'acp session list --scope-ref agent:larry:project:agent-spaces --json',
  })
}

function renderSessionResolveHelp(): string {
  return renderSimpleHelp({
    usage: 'acp session resolve --scope-ref <scopeRef> [--lane-ref <laneRef>] [options]',
    summary: 'Resolve a semantic SessionRef into a concrete session id.',
    example: 'acp session resolve --scope-ref agent:larry:project:agent-spaces --json',
  })
}

function renderSessionListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp session list [--scope-ref <scopeRef>] [--lane-ref <laneRef>] [options]',
    summary: 'List active ACP sessions.',
    example: 'acp session list --scope-ref agent:larry:project:agent-spaces --table',
    options: ['--server <url>', '--json', '--table'],
  })
}

function renderSessionShowHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp session show (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [options]',
    summary: 'Show one ACP session.',
    example: 'acp session show --session hsid-123 --json',
  })
}

function renderSessionRunsHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp session runs (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [options]',
    summary: 'List runs associated with one session.',
    example: 'acp session runs --session hsid-123 --table',
  })
}

function renderSessionResetHelp(): string {
  return renderSimpleHelp({
    usage: 'acp session reset --scope-ref <scopeRef> [--lane-ref <laneRef>] [options]',
    summary: 'Reset one semantic session reference.',
    example: 'acp session reset --scope-ref agent:larry:project:agent-spaces --json',
  })
}

function renderSessionInterruptHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp session interrupt (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [options]',
    summary: 'Interrupt the latest runtime for a session.',
    example: 'acp session interrupt --session hsid-123 --json',
  })
}

function renderSessionCaptureHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp session capture (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [options]',
    summary: 'Capture recent runtime output for a session.',
    example: 'acp session capture --session hsid-123 --table',
  })
}

function renderSessionAttachCommandHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp session attach-command (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [options]',
    summary: 'Get the live attach command for a session runtime.',
    example: 'acp session attach-command --session hsid-123 --json',
  })
}

function renderRunHelp(): string {
  return renderSimpleHelp({
    usage: 'acp run <show|cancel> --run <runId> [options]',
    summary: 'Inspect or cancel ACP runs.',
    example: 'acp run show --run run_123 --json',
  })
}

function renderRunShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp run show --run <runId> [options]',
    summary: 'Show one ACP run.',
    example: 'acp run show --run run_123 --json',
  })
}

function renderRunCancelHelp(): string {
  return renderSimpleHelp({
    usage: 'acp run cancel --run <runId> [options]',
    summary: 'Cancel one ACP run.',
    example: 'acp run cancel --run run_123 --json',
  })
}

function renderSendHelp(): string {
  return renderSimpleHelp({
    usage: 'acp send --scope-ref <scopeRef> [--lane-ref <laneRef>] --text <text> [options]',
    summary: 'Create an input attempt and ACP run for one session reference.',
    example: 'acp send --scope-ref agent:larry:project:agent-spaces --text "Proceed" --wait --json',
    options: [
      '--idempotency-key <key>',
      '--meta <json>',
      '--wait',
      '--wait-timeout-ms <ms>',
      '--wait-interval-ms <ms>',
      '--no-dispatch',
      '--server <url>',
      '--actor <agentId>',
      '--json',
      '--table',
    ],
  })
}

function renderTailHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp tail (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [--from-seq <n>] [options]',
    summary:
      'Live tail of /sessions/{id}/events. Streams NDJSON records incrementally as they arrive (does not buffer the full response). Use --json or --table for structured output.',
    example: 'acp tail --session hsid-123 --from-seq 41',
  })
}

function renderRenderHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp render (--session <sessionId> | --scope-ref <scopeRef> [--lane-ref <laneRef>]) [--source replay|capture] [options]',
    summary:
      'Replay-derived render: reduces the /events stream into a text view (default). Use --source capture for a point-in-time capture snapshot.',
    example: 'acp render --scope-ref agent:larry:project:agent-spaces --table',
  })
}

function renderMessageHelp(): string {
  return renderSimpleHelp({
    usage: 'acp message <send|broadcast> [options]',
    summary: 'Send coordination messages.',
    example:
      'acp message send --project agent-spaces --from-agent larry --to-agent clod --text "ready" --json',
  })
}

function renderMessageSendHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp message send --project <projectId> --text <text> (--to-agent <agentId> | --to-human <humanId> | --to-session <scopeRef> | --to-system) [options]',
    summary: 'Send one coordination message to one recipient.',
    example:
      'acp message send --project agent-spaces --from-agent larry --to-agent clod --text "Please review" --json',
    options: [
      '--from-agent <agentId> | --from-human <humanId> | --from-session <scopeRef> | --from-system',
      '--to-lane-ref <laneRef>   Used with --to-session',
      '--wake',
      '--dispatch',
      '--coordination-only',
      '--server <url>',
      '--actor <agentId>',
      '--json',
      '--table',
    ],
  })
}

function renderMessageBroadcastHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp message broadcast --project <projectId> --text <text> [--to-agent <agentId>]... [options]',
    summary: 'Broadcast one coordination message to repeated explicit recipients.',
    example:
      'acp message broadcast --project agent-spaces --from-agent larry --to-agent clod --to-agent rex --text "deploy starts now" --json',
  })
}

function renderJobHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job <create|list|show|patch|run> [options]',
    summary: 'Create, inspect, patch, or trigger ACP jobs.',
    example: 'acp job list --json',
  })
}

function renderJobCreateHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp job create --project <projectId> --agent <agentId> --scope-ref <scopeRef> --cron <expr> --input <json> [--job <jobId>] [options]',
    summary: 'Create one ACP job.',
    example:
      'acp job create --project agent-spaces --agent larry --scope-ref agent:larry:project:agent-spaces --cron "0 * * * *" --input {"content":"status"} --json',
    options: ['--lane-ref <laneRef>', '--disabled', '--server <url>', '--json', '--table'],
  })
}

function renderJobListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job list [--project <projectId>] [options]',
    summary: 'List ACP jobs.',
    example: 'acp job list --project agent-spaces --table',
  })
}

function renderJobShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job show --job <jobId> [options]',
    summary: 'Show one ACP job.',
    example: 'acp job show --job job_daily_status --json',
  })
}

function renderJobPatchHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp job patch --job <jobId> [--cron <expr>] [--input <json>] [--enabled|--disabled] [options]',
    summary: 'Patch one ACP job.',
    example: 'acp job patch --job job_daily_status --disabled --json',
  })
}

function renderJobRunHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job run --job <jobId> [options]',
    summary: 'Trigger one ACP job immediately.',
    example: 'acp job run --job job_daily_status --json',
  })
}

function renderJobRunFamilyHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job-run <list|show> [options]',
    summary: 'Inspect job-run records.',
    example: 'acp job-run list --job job_daily_status --json',
  })
}

function renderJobRunListHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job-run list --job <jobId> [options]',
    summary: 'List job runs for one job.',
    example: 'acp job-run list --job job_daily_status --table',
  })
}

function renderJobRunShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp job-run show --job-run <jobRunId> [options]',
    summary: 'Show one job run.',
    example: 'acp job-run show --job-run jr_123 --json',
  })
}

function renderHeartbeatHelp(): string {
  return renderSimpleHelp({
    usage: 'acp heartbeat <set|wake> [options]',
    summary: 'Set agent heartbeats or trigger operator wakes.',
    example: 'acp heartbeat wake --agent larry --reason operator_wake --json',
  })
}

function renderHeartbeatSetHelp(): string {
  return renderSimpleHelp({
    usage: 'acp heartbeat set --agent <agentId> [options]',
    summary: 'Upsert one agent heartbeat.',
    example: 'acp heartbeat set --agent larry --json',
  })
}

function renderHeartbeatWakeHelp(): string {
  return renderSimpleHelp({
    usage: 'acp heartbeat wake --agent <agentId> --reason <reason> [options]',
    summary: 'Trigger one agent heartbeat wake request.',
    example: 'acp heartbeat wake --agent larry --reason operator_wake --json',
  })
}

function renderDeliveryHelp(): string {
  return renderSimpleHelp({
    usage: 'acp delivery <retry|list-failed> [options]',
    summary: 'Retry failed deliveries or list failed delivery records.',
    example: 'acp delivery list-failed --json',
  })
}

function renderDeliveryRetryHelp(): string {
  return renderSimpleHelp({
    usage: 'acp delivery retry --delivery <deliveryRequestId> [--requeued-by <actor>] [options]',
    summary: 'Requeue one failed delivery.',
    example: 'acp delivery retry --delivery dr_123 --requeued-by larry --json',
  })
}

function renderDeliveryListFailedHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp delivery list-failed [--gateway <gatewayId>] [--since <cursor>] [--limit <n>] [options]',
    summary: 'List failed gateway deliveries.',
    example: 'acp delivery list-failed --limit 20 --table',
  })
}

function renderThreadHelp(): string {
  return renderSimpleHelp({
    usage: 'acp thread <list|show|turns> [options]',
    summary: 'Inspect conversation threads and turns.',
    example: 'acp thread list --project agent-spaces --json',
  })
}

function renderThreadListHelp(): string {
  return renderSimpleHelp({
    usage:
      'acp thread list [--project <projectId>] [--scope-ref <scopeRef> [--lane-ref <laneRef>]] [options]',
    summary: 'List conversation threads.',
    example: 'acp thread list --project agent-spaces --table',
  })
}

function renderThreadShowHelp(): string {
  return renderSimpleHelp({
    usage: 'acp thread show --thread <threadId> [options]',
    summary: 'Show one conversation thread.',
    example: 'acp thread show --thread thread_123 --json',
  })
}

function renderThreadTurnsHelp(): string {
  return renderSimpleHelp({
    usage: 'acp thread turns --thread <threadId> [--since <cursor>] [--limit <n>] [options]',
    summary: 'List turns for one conversation thread.',
    example: 'acp thread turns --thread thread_123 --table',
  })
}

async function runTaskCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderTaskHelp()}\n`)
    return
  }

  if (subcommand === 'create') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderTaskCreateHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskCreateCommand(rest, deps))
    return
  }

  if (subcommand === 'show') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderTaskShowHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskShowCommand(rest, deps))
    return
  }

  if (subcommand === 'promote') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderTaskPromoteHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskPromoteCommand(rest, deps))
    return
  }

  if (subcommand === 'evidence') {
    const nestedSubcommand = rest[0]
    const nestedArgs = rest.slice(1)
    if (
      nestedSubcommand === undefined ||
      nestedSubcommand === '--help' ||
      nestedSubcommand === '-h'
    ) {
      process.stdout.write(`${renderTaskEvidenceHelp()}\n`)
      return
    }
    if (nestedSubcommand !== 'add') {
      throw new CliUsageError(`unknown task evidence subcommand: ${nestedSubcommand}`)
    }
    if (nestedArgs.includes('--help') || nestedArgs.includes('-h')) {
      process.stdout.write(`${renderTaskEvidenceHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskEvidenceAddCommand(nestedArgs, deps))
    return
  }

  if (subcommand === 'transition') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderTaskTransitionHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskTransitionCommand(rest, deps))
    return
  }

  if (subcommand === 'transitions') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderTaskTransitionsHelp()}\n`)
      return
    }
    writeCommandOutput(await runTaskTransitionsCommand(rest, deps))
    return
  }

  throw new CliUsageError(`unknown task subcommand: ${subcommand}`)
}

async function runAdminInterfaceBindingCommand(
  args: string[],
  deps: CommandDependencies
): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderAdminInterfaceHelp()}\n`)
    return
  }

  if (subcommand === 'list') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderAdminInterfaceBindingListHelp()}\n`)
      return
    }
    writeCommandOutput(await runAdminInterfaceBindingListCommand(rest, deps))
    return
  }

  if (subcommand === 'set') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderAdminInterfaceBindingSetHelp()}\n`)
      return
    }
    writeCommandOutput(await runAdminInterfaceBindingSetCommand(rest, deps))
    return
  }

  if (subcommand === 'disable') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(`${renderAdminInterfaceBindingDisableHelp()}\n`)
      return
    }
    writeCommandOutput(await runAdminInterfaceBindingDisableCommand(rest, deps))
    return
  }

  throw new CliUsageError(`unknown admin interface binding subcommand: ${subcommand}`)
}

async function runAdminCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderAdminHelp()}\n`)
    return
  }

  if (subcommand !== 'interface') {
    throw new CliUsageError(`unknown admin subcommand: ${subcommand}`)
  }

  const nestedSubcommand = rest[0]
  const nestedArgs = rest.slice(1)
  if (
    nestedSubcommand === undefined ||
    nestedSubcommand === '--help' ||
    nestedSubcommand === '-h'
  ) {
    process.stdout.write(`${renderAdminInterfaceHelp()}\n`)
    return
  }

  if (nestedSubcommand !== 'binding') {
    throw new CliUsageError(`unknown admin interface subcommand: ${nestedSubcommand}`)
  }

  await runAdminInterfaceBindingCommand(nestedArgs, deps)
}

async function runAgentCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderAgentHelp()}\n`)
    return
  }
  if (subcommand === 'create' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderAgentCreateHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderAgentListHelp()}\n`)
    return
  }
  if (subcommand === 'show' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderAgentShowHelp()}\n`)
    return
  }
  if (subcommand === 'patch' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderAgentPatchHelp()}\n`)
    return
  }
  writeCommandOutput(await runAgentCommand(args, deps))
}

async function runProjectCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderProjectHelp()}\n`)
    return
  }
  if (subcommand === 'create' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderProjectCreateHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderProjectListHelp()}\n`)
    return
  }
  if (subcommand === 'show' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderProjectShowHelp()}\n`)
    return
  }
  if (subcommand === 'default-agent' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderProjectDefaultAgentHelp()}\n`)
    return
  }
  writeCommandOutput(await runProjectCommand(args, deps))
}

async function runMembershipCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderMembershipHelp()}\n`)
    return
  }
  if (subcommand === 'add' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderMembershipAddHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderMembershipListHelp()}\n`)
    return
  }
  writeCommandOutput(await runMembershipCommand(args, deps))
}

async function runInterfaceCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderInterfaceHelp()}\n`)
    return
  }
  if (subcommand !== 'identity') {
    throw new CliUsageError(`unknown interface subcommand: ${subcommand}`)
  }
  if (rest[0] === undefined || rest[0] === '--help' || rest[0] === '-h') {
    process.stdout.write(`${renderInterfaceIdentityRegisterHelp()}\n`)
    return
  }
  if (rest[0] !== 'register') {
    throw new CliUsageError(`unknown interface identity subcommand: ${rest[0]}`)
  }
  if (rest.slice(1).includes('--help') || rest.slice(1).includes('-h')) {
    process.stdout.write(`${renderInterfaceIdentityRegisterHelp()}\n`)
    return
  }
  writeCommandOutput(await runInterfaceIdentityCommand(rest, deps))
}

async function runSystemEventCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderSystemEventHelp()}\n`)
    return
  }
  if (subcommand === 'push' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderSystemEventPushHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderSystemEventListHelp()}\n`)
    return
  }
  writeCommandOutput(await runSystemEventCommand(args, deps))
}

async function runRuntimeCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  if (args[0] === undefined || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`${renderRuntimeHelp()}\n`)
    return
  }
  if (args[0] === 'resolve' && (args.slice(1).includes('--help') || args.slice(1).includes('-h'))) {
    process.stdout.write(`${renderRuntimeHelp()}\n`)
    return
  }
  writeCommandOutput(await runRuntimeCommand(args, deps))
}

async function runSessionCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderSessionHelp()}\n`)
    return
  }

  const helpMap: Record<string, string> = {
    resolve: renderSessionResolveHelp(),
    list: renderSessionListHelp(),
    show: renderSessionShowHelp(),
    runs: renderSessionRunsHelp(),
    reset: renderSessionResetHelp(),
    interrupt: renderSessionInterruptHelp(),
    capture: renderSessionCaptureHelp(),
    'attach-command': renderSessionAttachCommandHelp(),
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    const help = helpMap[subcommand]
    if (help !== undefined) {
      process.stdout.write(`${help}\n`)
      return
    }
  }
  writeCommandOutput(await runSessionCommand(args, deps))
}

async function runRunCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderRunHelp()}\n`)
    return
  }
  if (subcommand === 'show' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderRunShowHelp()}\n`)
    return
  }
  if (subcommand === 'cancel' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderRunCancelHelp()}\n`)
    return
  }
  writeCommandOutput(await runRunCommand(args, deps))
}

async function runMessageCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderMessageHelp()}\n`)
    return
  }
  if (subcommand === 'send' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderMessageSendHelp()}\n`)
    return
  }
  if (subcommand === 'broadcast' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderMessageBroadcastHelp()}\n`)
    return
  }
  writeCommandOutput(await runMessageCommand(args, deps))
}

async function runJobCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderJobHelp()}\n`)
    return
  }
  const helpMap: Record<string, string> = {
    create: renderJobCreateHelp(),
    list: renderJobListHelp(),
    show: renderJobShowHelp(),
    patch: renderJobPatchHelp(),
    run: renderJobRunHelp(),
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    const help = helpMap[subcommand]
    if (help !== undefined) {
      process.stdout.write(`${help}\n`)
      return
    }
  }
  writeCommandOutput(await runJobCommand(args, deps))
}

async function runJobRunCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderJobRunFamilyHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderJobRunListHelp()}\n`)
    return
  }
  if (subcommand === 'show' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderJobRunShowHelp()}\n`)
    return
  }
  writeCommandOutput(await runJobRunCommand(args, deps))
}

async function runHeartbeatCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderHeartbeatHelp()}\n`)
    return
  }
  if (subcommand === 'set' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderHeartbeatSetHelp()}\n`)
    return
  }
  if (subcommand === 'wake' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderHeartbeatWakeHelp()}\n`)
    return
  }
  writeCommandOutput(await runHeartbeatCommand(args, deps))
}

async function runDeliveryCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderDeliveryHelp()}\n`)
    return
  }
  if (subcommand === 'retry' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderDeliveryRetryHelp()}\n`)
    return
  }
  if (subcommand === 'list-failed' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderDeliveryListFailedHelp()}\n`)
    return
  }
  writeCommandOutput(await runDeliveryCommand(args, deps))
}

async function runThreadCliCommand(args: string[], deps: CommandDependencies): Promise<void> {
  const subcommand = args[0]
  const rest = args.slice(1)
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderThreadHelp()}\n`)
    return
  }
  if (subcommand === 'list' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderThreadListHelp()}\n`)
    return
  }
  if (subcommand === 'show' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderThreadShowHelp()}\n`)
    return
  }
  if (subcommand === 'turns' && (rest.includes('--help') || rest.includes('-h'))) {
    process.stdout.write(`${renderThreadTurnsHelp()}\n`)
    return
  }
  writeCommandOutput(await runThreadCommand(args, deps))
}

export async function main(
  args = process.argv.slice(2),
  deps: CommandDependencies = {}
): Promise<void> {
  const jsonRequested = args.includes('--json')

  try {
    const command = args[0]
    if (command === undefined) {
      process.stderr.write(`${renderTopLevelHelp()}\n`)
      process.exit(1)
    }

    if (command === '--help' || command === '-h') {
      process.stdout.write(`${renderTopLevelHelp()}\n`)
      return
    }

    if (command === 'task') {
      await runTaskCommand(args.slice(1), deps)
      return
    }
    if (command === 'agent') {
      await runAgentCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'project') {
      await runProjectCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'membership') {
      await runMembershipCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'interface') {
      await runInterfaceCommand(args.slice(1), deps)
      return
    }
    if (command === 'system-event') {
      await runSystemEventCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'admin') {
      await runAdminCommand(args.slice(1), deps)
      return
    }
    if (command === 'runtime') {
      await runRuntimeCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'session') {
      await runSessionCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'run') {
      await runRunCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'send') {
      if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
        process.stdout.write(`${renderSendHelp()}\n`)
        return
      }
      writeCommandOutput(await runSendCommand(args.slice(1), deps))
      return
    }
    if (command === 'tail') {
      if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
        process.stdout.write(`${renderTailHelp()}\n`)
        return
      }
      writeCommandOutput(await runTailCommand(args.slice(1), deps))
      return
    }
    if (command === 'render') {
      if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
        process.stdout.write(`${renderRenderHelp()}\n`)
        return
      }
      writeCommandOutput(await runRenderCommand(args.slice(1), deps))
      return
    }
    if (command === 'message') {
      await runMessageCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'job') {
      await runJobCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'job-run') {
      await runJobRunCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'heartbeat') {
      await runHeartbeatCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'delivery') {
      await runDeliveryCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'thread') {
      await runThreadCliCommand(args.slice(1), deps)
      return
    }
    if (command === 'server') {
      await runServerCommand(args.slice(1))
      return
    }

    throw new CliUsageError(`unknown subcommand: ${command}`)
  } catch (error) {
    exitWithError(error, { json: jsonRequested })
  }
}

if (import.meta.main) {
  await main()
}
