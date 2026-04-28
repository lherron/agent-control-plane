#!/usr/bin/env bun

import { repeatable } from 'cli-kit'
import { Command, CommanderError } from 'commander'

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
import type { CommandDependencies, CommandOutput } from './commands/shared.js'
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

type GlobalOptions = {
  actor?: string | undefined
  json?: boolean | undefined
  server?: string | undefined
}

type CommandHandler = (args: string[], deps: CommandDependencies) => Promise<CommandOutput>

type CommanderOption = {
  flags: string
  long?: string | undefined
  attributeName(): string
}

function collectOptions(command: Command): CommanderOption[] {
  const chain: Command[] = []
  for (let current: Command | null = command; current !== null; current = current.parent) {
    chain.unshift(current)
  }

  const seen = new Set<string>()
  const options: CommanderOption[] = []
  for (const current of chain) {
    for (const option of current.options as unknown as CommanderOption[]) {
      const key = option.long ?? option.flags
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      options.push(option)
    }
  }
  return options
}

function optionLongFlag(option: CommanderOption, value: unknown): string | undefined {
  if (option.long !== undefined) {
    return option.long
  }

  const match = option.flags.match(/--[a-z0-9-]+/)
  if (match === null) {
    return undefined
  }

  const flag = match[0]
  if (option.flags.includes(`--no-${flag.slice(2)}`) && value === false) {
    return `--no-${flag.slice(2)}`
  }
  return flag
}

function legacyArgs(command: Command, positionals: readonly string[] = []): string[] {
  const opts = command.optsWithGlobals<Record<string, unknown>>()
  const args = [...positionals]
  for (const option of collectOptions(command)) {
    const key = option.attributeName()
    const value = opts[key]
    const flag = optionLongFlag(option, value)
    if (flag === undefined || value === undefined) {
      continue
    }

    if (value === false) {
      if (flag.startsWith('--no-')) {
        args.push(flag)
      }
      continue
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        args.push(flag, String(entry))
      }
      continue
    }

    if (value === true) {
      args.push(flag)
      continue
    }

    args.push(flag, String(value))
  }
  return args
}

function runLeaf(
  deps: CommandDependencies,
  path: readonly string[],
  handler: CommandHandler,
  positionals: readonly string[] = []
): (this: Command, ...args: unknown[]) => Promise<void> {
  return async function (this: Command, ...args: unknown[]) {
    const command = (args.at(-1) as Command | undefined) ?? this
    const actionPositionals =
      positionals.length > 0 ? positionals : args.slice(0, -2).map((value) => String(value))
    writeCommandOutput(await handler([...path, ...legacyArgs(command, actionPositionals)], deps))
  }
}

function runLeafWithPositionals(
  deps: CommandDependencies,
  path: readonly string[],
  handler: CommandHandler
): (...args: unknown[]) => Promise<void> {
  return async function (this: Command, ...args: unknown[]) {
    const command = (args.at(-1) as Command | undefined) ?? this
    const positionals = args.slice(0, -2).map((value) => String(value))
    writeCommandOutput(await handler([...path, ...legacyArgs(command, positionals)], deps))
  }
}

function common(cmd: Command): Command {
  return cmd
    .option('--server <url>', 'ACP server URL')
    .option('--actor <agentId>', 'actor agent id')
    .option('--json', 'emit JSON output')
}

function tabular(cmd: Command): Command {
  return common(cmd).option('--table', 'emit table output')
}

function addTaskCommands(program: Command, deps: CommandDependencies): void {
  const task = program.command('task').description('manage ACP workflow tasks')

  common(task.command('create').description('create a preset-driven ACP workflow task'))
    .requiredOption('--preset <id>')
    .requiredOption('--preset-version <n>')
    .requiredOption('--risk-class <class>')
    .requiredOption('--project <projectId>')
    .option('--kind <kind>')
    .option('--meta <json>')
    .option('--role <assignment>', 'role:agentId (repeatable)', repeatable(), [])
    .action(runLeaf(deps, [], runTaskCreateCommand))

  common(task.command('show').description('show one task'))
    .requiredOption('--task <taskId>')
    .option('--role <role>')
    .action(runLeaf(deps, [], runTaskShowCommand))

  common(task.command('promote').description('promote a wrkq task into ACP workflow control'))
    .requiredOption('--task <taskId>')
    .requiredOption('--preset <id>')
    .requiredOption('--preset-version <n>')
    .requiredOption('--risk-class <class>')
    .option('--actor-role <role>')
    .option('--initial-phase <phase>')
    .option('--role <assignment>', 'role:agentId (repeatable)', repeatable(), [])
    .action(runLeaf(deps, [], runTaskPromoteCommand))

  const evidence = task.command('evidence').description('manage task evidence')
  common(evidence.command('add').description('attach evidence to a task'))
    .requiredOption('--task <taskId>')
    .requiredOption('--kind <kind>')
    .requiredOption('--ref <ref>')
    .requiredOption('--producer-role <role>')
    .option('--build-id <id>')
    .option('--build-version <version>')
    .option('--build-env <env>')
    .option('--content-hash <hash>')
    .option('--meta <json>')
    .action(runLeaf(deps, [], runTaskEvidenceAddCommand))

  common(task.command('transition').description('apply one task phase transition'))
    .requiredOption('--task <taskId>')
    .requiredOption('--to <phase>')
    .requiredOption('--actor-role <role>')
    .requiredOption('--expected-version <n>')
    .option('--evidence <refs>')
    .option('--idempotency-key <key>')
    .option('--request-handoff')
    .option('--waiver <kind:ref>', 'repeatable waiver evidence', repeatable(), [])
    .action(runLeaf(deps, [], runTaskTransitionCommand))

  common(task.command('transitions').description('list task transition history'))
    .requiredOption('--task <taskId>')
    .action(runLeaf(deps, [], runTaskTransitionsCommand))
}

function addAdminCommands(program: Command, deps: CommandDependencies): void {
  const binding = program
    .command('admin')
    .description('manage ACP admin bindings')
    .command('interface')
    .description('manage interface admin resources')
    .command('binding')
    .description('manage interface bindings')

  common(binding.command('list').description('list interface bindings'))
    .option('--gateway <id>')
    .option('--conversation-ref <ref>')
    .option('--thread-ref <ref>')
    .option('--project <projectId>')
    .action(runLeaf(deps, [], runAdminInterfaceBindingListCommand))

  common(binding.command('set').description('upsert one interface binding'))
    .requiredOption('--gateway <id>')
    .requiredOption('--conversation-ref <ref>')
    .option('--thread-ref <ref>')
    .option('--project <projectId>')
    .option('--session <handle>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .action(runLeaf(deps, [], runAdminInterfaceBindingSetCommand))

  common(binding.command('disable').description('disable one interface binding'))
    .requiredOption('--gateway <id>')
    .requiredOption('--conversation-ref <ref>')
    .option('--thread-ref <ref>')
    .action(runLeaf(deps, [], runAdminInterfaceBindingDisableCommand))
}

function addGovernanceCommands(program: Command, deps: CommandDependencies): void {
  const agent = program.command('agent').description('manage ACP admin agents')
  common(agent.command('create').description('create one agent'))
    .requiredOption('--agent <agentId>')
    .requiredOption('--status <active|disabled>')
    .option('--display-name <name>')
    .option('--home-dir <path>')
    .action(runLeaf(deps, ['create'], runAgentCommand))
  common(agent.command('list').description('list agents')).action(
    runLeaf(deps, ['list'], runAgentCommand)
  )
  common(agent.command('show').description('show one agent'))
    .requiredOption('--agent <agentId>')
    .action(runLeaf(deps, ['show'], runAgentCommand))
  common(agent.command('patch').description('patch one agent'))
    .requiredOption('--agent <agentId>')
    .option('--display-name <name>')
    .option('--home-dir <path>')
    .option('--status <active|disabled>')
    .action(runLeaf(deps, ['patch'], runAgentCommand))

  const project = program.command('project').description('manage ACP projects')
  common(project.command('create').description('create one project'))
    .requiredOption('--project <projectId>')
    .requiredOption('--display-name <name>')
    .option('--root-dir <path>')
    .action(runLeaf(deps, ['create'], runProjectCommand))
  common(project.command('list').description('list projects')).action(
    runLeaf(deps, ['list'], runProjectCommand)
  )
  common(project.command('show').description('show one project'))
    .requiredOption('--project <projectId>')
    .action(runLeaf(deps, ['show'], runProjectCommand))
  common(project.command('default-agent').description('set project default agent'))
    .requiredOption('--project <projectId>')
    .requiredOption('--agent <agentId>')
    .action(runLeaf(deps, ['default-agent'], runProjectCommand))

  const membership = program.command('membership').description('manage project memberships')
  common(membership.command('add').description('add one membership'))
    .requiredOption('--project <projectId>')
    .requiredOption('--agent <agentId>')
    .requiredOption('--role <role>')
    .action(runLeaf(deps, ['add'], runMembershipCommand))
  common(membership.command('list').description('list memberships'))
    .requiredOption('--project <projectId>')
    .action(runLeaf(deps, ['list'], runMembershipCommand))

  const identity = program
    .command('interface')
    .description('manage interface identities')
    .command('identity')
    .description('manage interface identities')
  common(identity.command('register').description('register one interface identity'))
    .requiredOption('--gateway <id>')
    .requiredOption('--external-id <ref>')
    .option('--display-name <name>')
    .option('--linked-agent <agentId>')
    .action(runLeaf(deps, ['register'], runInterfaceIdentityCommand))

  const systemEvent = program.command('system-event').description('append or list system events')
  common(systemEvent.command('push').description('append one system event'))
    .requiredOption('--project <projectId>')
    .requiredOption('--kind <kind>')
    .requiredOption('--payload <json>')
    .requiredOption('--occurred-at <iso8601>')
    .action(runLeaf(deps, ['push'], runSystemEventCommand))
  common(systemEvent.command('list').description('list system events'))
    .option('--project <projectId>')
    .option('--kind <kind>')
    .option('--occurred-after <iso8601>')
    .option('--occurred-before <iso8601>')
    .action(runLeaf(deps, ['list'], runSystemEventCommand))
}

function addRuntimeCommands(program: Command, deps: CommandDependencies): void {
  const runtime = program.command('runtime').description('resolve runtime placement')
  tabular(runtime.command('resolve').description('resolve runtime placement'))
    .requiredOption('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['resolve'], runRuntimeCommand))

  const session = program.command('session').description('resolve, inspect, and control sessions')
  for (const name of ['resolve', 'list', 'show', 'runs', 'reset', 'interrupt', 'capture']) {
    tabular(session.command(name).description(`${name} sessions`))
      .option('--session <sessionId>')
      .option('--scope-ref <scopeRef>')
      .option('--lane-ref <laneRef>')
      .option('--project <projectId>')
      .action(runLeaf(deps, [name], runSessionCommand))
  }
  tabular(session.command('attach-command').description('get a session attach command'))
    .option('--session <sessionId>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['attach-command'], runSessionCommand))

  const run = program.command('run').description('inspect or cancel runs')
  tabular(run.command('show').description('show one run'))
    .requiredOption('--run <runId>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['show'], runRunCommand))
  tabular(run.command('cancel').description('cancel one run'))
    .requiredOption('--run <runId>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['cancel'], runRunCommand))

  const attachment = run.command('attachment').description('manage outbound attachments')
  common(attachment.command('add').description('add one outbound attachment'))
    .argument('<path>')
    .option('--run <runId>')
    .option('--project <projectId>')
    .option('--alt <text>')
    .option('--filename <name>')
    .option('--content-type <mime>')
    .action(runLeafWithPositionals(deps, ['attachment', 'add'], runRunCommand))
  common(attachment.command('list').description('list outbound attachments'))
    .option('--run <runId>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['attachment', 'list'], runRunCommand))
  common(attachment.command('clear').description('clear outbound attachments'))
    .option('--run <runId>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['attachment', 'clear'], runRunCommand))

  tabular(program.command('send').description('send an input into a session'))
    .requiredOption('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .requiredOption('--text <text>')
    .option('--idempotency-key <key>')
    .option('--meta <json>')
    .option('--project <projectId>')
    .option('--wait')
    .option('--wait-timeout-ms <ms>')
    .option('--wait-interval-ms <ms>')
    .option('--no-dispatch')
    .action(runLeaf(deps, [], runSendCommand))

  tabular(program.command('tail').description('live-stream session events'))
    .option('--session <sessionId>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .option('--from-seq <n>')
    .option('--project <projectId>')
    .action(runLeaf(deps, [], runTailCommand))

  tabular(program.command('render').description('render a session replay or capture'))
    .option('--session <sessionId>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .option('--project <projectId>')
    .option('--source <replay|capture>')
    .action(runLeaf(deps, [], runRenderCommand))
}

function addCoordinationCommands(program: Command, deps: CommandDependencies): void {
  const message = program.command('message').description('send coordination messages')
  for (const name of ['send', 'broadcast']) {
    tabular(message.command(name).description(`${name} coordination message`))
      .requiredOption('--project <projectId>')
      .requiredOption('--text <text>')
      .option('--from-agent <agentId>')
      .option('--from-human <humanId>')
      .option('--from-session <scopeRef>')
      .option('--from-lane-ref <laneRef>')
      .option('--from-system')
      .option('--to-agent <agentId>', 'recipient agent (repeatable)', repeatable(), [])
      .option('--to-human <humanId>', 'recipient human (repeatable)', repeatable(), [])
      .option('--to-session <scopeRef>', 'recipient session (repeatable)', repeatable(), [])
      .option('--to-lane-ref <laneRef>')
      .option('--to-system')
      .option('--wake')
      .option('--dispatch')
      .option('--coordination-only')
      .action(runLeaf(deps, [name], runMessageCommand))
  }

  const job = program.command('job').description('manage scheduled jobs')
  tabular(job.command('validate').description('validate a job file'))
    .requiredOption('--in <file>', 'JSON job file to validate')
    .action(runLeaf(deps, ['validate'], runJobCommand))
  tabular(job.command('create').description('create one job'))
    .option('--job <jobId>')
    .option('--in <file>', 'JSON job file to import')
    .option('--project <projectId>')
    .option('--agent <agentId>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .option('--cron <expr>')
    .option('--input <json>')
    .option('--disabled')
    .action(runLeaf(deps, ['create'], runJobCommand))
  tabular(job.command('list').description('list jobs'))
    .option('--project <projectId>')
    .action(runLeaf(deps, ['list'], runJobCommand))
  tabular(job.command('show').description('show one job'))
    .requiredOption('--job <jobId>')
    .action(runLeaf(deps, ['show'], runJobCommand))
  tabular(job.command('patch').description('patch one job'))
    .requiredOption('--job <jobId>')
    .option('--in <file>', 'JSON job file to import')
    .option('--cron <expr>')
    .option('--input <json>')
    .option('--enabled')
    .option('--disabled')
    .action(runLeaf(deps, ['patch'], runJobCommand))
  tabular(job.command('run').description('trigger one job'))
    .requiredOption('--job <jobId>')
    .option('--wait', 'poll until job run reaches terminal status')
    .option('--poll-interval <ms>', 'poll interval in ms (default: 1000)')
    .option('--timeout <ms>', 'timeout in ms (default: 600000)')
    .action(runLeaf(deps, ['run'], runJobCommand))

  const jobRun = program.command('job-run').description('inspect job runs')
  tabular(jobRun.command('list').description('list job runs'))
    .requiredOption('--job <jobId>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['list'], runJobRunCommand))
  tabular(jobRun.command('show').description('show one job run'))
    .requiredOption('--job-run <jobRunId>')
    .option('--project <projectId>')
    .option('--steps', 'render steps table')
    .option('--results', 'render step results table')
    .action(runLeaf(deps, ['show'], runJobRunCommand))
  tabular(jobRun.command('wait').description('poll a job run until terminal'))
    .requiredOption('--job-run <jobRunId>')
    .option('--project <projectId>')
    .option('--poll-interval <ms>', 'poll interval in ms (default: 1000)')
    .option('--timeout <ms>', 'timeout in ms (default: 600000)')
    .action(runLeaf(deps, ['wait'], runJobRunCommand))

  const heartbeat = program.command('heartbeat').description('set heartbeats or trigger wakes')
  common(heartbeat.command('set').description('set one heartbeat'))
    .requiredOption('--agent <agentId>')
    .option('--source <source>')
    .option('--note <note>')
    .option('--scope <scopeRef>')
    .option('--lane <laneRef>')
    .action(runLeaf(deps, ['set'], runHeartbeatCommand))
  common(heartbeat.command('wake').description('trigger one wake request'))
    .requiredOption('--agent <agentId>')
    .option('--reason <reason>')
    .option('--scope <scopeRef>')
    .option('--lane <laneRef>')
    .action(runLeaf(deps, ['wake'], runHeartbeatCommand))

  const delivery = program.command('delivery').description('retry or list failed deliveries')
  tabular(delivery.command('retry').description('retry one failed delivery'))
    .requiredOption('--delivery <deliveryRequestId>')
    .option('--requeued-by <actor>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['retry'], runDeliveryCommand))
  tabular(delivery.command('list-failed').description('list failed deliveries'))
    .option('--gateway <gatewayId>')
    .option('--since <cursor>')
    .option('--limit <n>')
    .option('--project <projectId>')
    .action(runLeaf(deps, ['list-failed'], runDeliveryCommand))

  const thread = program.command('thread').description('inspect conversation threads')
  tabular(thread.command('list').description('list threads'))
    .option('--project <projectId>')
    .option('--scope-ref <scopeRef>')
    .option('--lane-ref <laneRef>')
    .action(runLeaf(deps, ['list'], runThreadCommand))
  tabular(thread.command('show').description('show one thread'))
    .requiredOption('--thread <threadId>')
    .action(runLeaf(deps, ['show'], runThreadCommand))
  tabular(thread.command('turns').description('list thread turns'))
    .requiredOption('--thread <threadId>')
    .option('--since <cursor>')
    .option('--limit <n>')
    .action(runLeaf(deps, ['turns'], runThreadCommand))
}

export function buildProgram(
  deps: CommandDependencies = {},
  rawArgs: readonly string[] = []
): Command {
  const program = new Command()
    .name('acp')
    .description('ACP operator CLI')
    .exitOverride()
    .configureOutput({
      writeErr: () => {},
    })
    .option('--server <url>', 'ACP server URL')
    .option('--actor <agentId>', 'actor agent id')
    .option('--json', 'emit JSON output')

  addTaskCommands(program, deps)
  addAdminCommands(program, deps)
  addGovernanceCommands(program, deps)
  addRuntimeCommands(program, deps)
  addCoordinationCommands(program, deps)

  program
    .command('server')
    .description('manage the ACP HTTP server and Discord gateway process')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument('[args...]')
    .action(async () => {
      await runServerCommand(rawArgs.slice(1))
    })

  return program
}

export async function main(
  args = process.argv.slice(2),
  deps: CommandDependencies = {}
): Promise<void> {
  const program = buildProgram(deps, args)
  try {
    if (args.length === 0) {
      program.outputHelp({ error: true })
      throw new CliUsageError('missing command')
    }
    await program.parseAsync(['bun', 'acp', ...args])
  } catch (err) {
    const json = program.opts<GlobalOptions>().json ?? args.includes('--json')

    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        process.exit(0)
      }
      exitWithError(new CliUsageError(err.message), { json })
    }

    exitWithError(err, { json })
  }
}

if (import.meta.main) {
  try {
    const cliArgs = process.argv.slice(2)
    const program = buildProgram({}, cliArgs)
    if (cliArgs.length === 0) {
      program.outputHelp({ error: true })
      throw new CliUsageError('missing command')
    }
    await program.parseAsync(process.argv)
  } catch (err) {
    const json = process.argv.includes('--json')

    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
        err.code === 'commander.version'
      ) {
        process.exit(0)
      }
      exitWithError(new CliUsageError(err.message), { json })
    }

    exitWithError(err, { json })
  }
}
