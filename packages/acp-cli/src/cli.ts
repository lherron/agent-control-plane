#!/usr/bin/env bun

import { CliUsageError, exitWithError, writeCommandOutput } from './cli-runtime.js'
import { runAdminInterfaceBindingDisableCommand } from './commands/admin-interface-binding-disable.js'
import { runAdminInterfaceBindingListCommand } from './commands/admin-interface-binding-list.js'
import { runAdminInterfaceBindingSetCommand } from './commands/admin-interface-binding-set.js'
import type { CommandDependencies } from './commands/shared.js'
import { runTaskCreateCommand } from './commands/task-create.js'
import { runTaskEvidenceAddCommand } from './commands/task-evidence-add.js'
import { runTaskPromoteCommand } from './commands/task-promote.js'
import { runTaskShowCommand } from './commands/task-show.js'
import { runTaskTransitionCommand } from './commands/task-transition.js'
import { runTaskTransitionsCommand } from './commands/task-transitions.js'
import { runServerCommand } from './server-runtime.js'

function renderTopLevelHelp(): string {
  return [
    'Usage:',
    '  acp task <subcommand> [options]',
    '  acp admin <subcommand> [options]',
    '  acp server <subcommand> [options]',
    '',
    'Subcommands:',
    '  admin interface binding  Manage ACP interface bindings',
    '  server               Manage the ACP HTTP server and Discord gateway process',
    '  task create           Create a workflow task',
    '  task promote          Promote an existing wrkq task into ACP workflow control',
    '  task show             Show task state and role context',
    '  task evidence add     Attach evidence to a task',
    '  task transition       Apply a task transition',
    '  task transitions      List task transition history',
    '',
    'Environment:',
    '  ACP_SERVER_URL        ACP server base URL (default: http://127.0.0.1:18470)',
    '  ACP_ACTOR_AGENT_ID    Default actor id for write commands',
  ].join('\n')
}

function renderTaskHelp(): string {
  return [
    'Usage:',
    '  acp task <create|promote|show|evidence|transition|transitions> [options]',
  ].join('\n')
}

function renderTaskCreateHelp(): string {
  return [
    'Usage:',
    '  acp task create --preset <id> --preset-version <n> --risk-class <low|medium|high> --project <projectId> --role implementer:<agentId> [options]',
    '',
    'Options:',
    '  --role <role>:<agentId>   Repeatable role assignment',
    '  --actor <agentId>         Actor id (or ACP_ACTOR_AGENT_ID)',
    '  --kind <task|bug|spike|chore>',
    '  --meta <json>',
    '  --server <url>',
    '  --json',
  ].join('\n')
}

function renderTaskShowHelp(): string {
  return [
    'Usage:',
    '  acp task show --task <T-XXXXX> [--role <role>] [--actor <agentId>] [--server <url>] [--json]',
  ].join('\n')
}

function renderTaskPromoteHelp(): string {
  return [
    'Usage:',
    '  acp task promote --task <T-XXXXX> --preset <id> --preset-version <n> --risk-class <low|medium|high> --role implementer:<agentId> [options]',
    '',
    'Options:',
    '  --role <role>:<agentId>   Repeatable role assignment',
    '  --actor <agentId>         Actor id (or ACP_ACTOR_AGENT_ID)',
    '  --actor-role <role>       Defaults to triager',
    '  --initial-phase <phase>',
    '  --server <url>',
    '  --json',
  ].join('\n')
}

function renderTaskEvidenceHelp(): string {
  return [
    'Usage:',
    '  acp task evidence add --task <T-XXXXX> --kind <kind> --ref <ref> --producer-role <role> [options]',
  ].join('\n')
}

function renderTaskTransitionHelp(): string {
  return [
    'Usage:',
    '  acp task transition --task <T-XXXXX> --to <phase> --actor-role <role> --expected-version <n> [options]',
  ].join('\n')
}

function renderTaskTransitionsHelp(): string {
  return ['Usage:', '  acp task transitions --task <T-XXXXX> [--server <url>] [--json]'].join('\n')
}

function renderAdminHelp(): string {
  return ['Usage:', '  acp admin interface binding <list|set|disable> [options]'].join('\n')
}

function renderAdminInterfaceHelp(): string {
  return ['Usage:', '  acp admin interface binding <list|set|disable> [options]'].join('\n')
}

function renderAdminInterfaceBindingListHelp(): string {
  return [
    'Usage:',
    '  acp admin interface binding list [--gateway <id>] [--conversation-ref <ref>] [--thread-ref <ref>] [--project <projectId>] [--server <url>] [--json]',
  ].join('\n')
}

function renderAdminInterfaceBindingSetHelp(): string {
  return [
    'Usage:',
    '  acp admin interface binding set --gateway <id> --conversation-ref <ref> (--session <handle> | --scope-ref <scopeRef>) [options]',
    '',
    'Options:',
    '  --thread-ref <ref>',
    '  --project <projectId>',
    '  --lane-ref <laneRef>      Used with --scope-ref; defaults to main if omitted',
    '  --actor <agentId>         Actor id (or ACP_ACTOR_AGENT_ID)',
    '  --server <url>',
    '  --json',
  ].join('\n')
}

function renderAdminInterfaceBindingDisableHelp(): string {
  return [
    'Usage:',
    '  acp admin interface binding disable --gateway <id> --conversation-ref <ref> [--thread-ref <ref>] [--server <url>] [--json]',
  ].join('\n')
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

    if (command === 'admin') {
      await runAdminCommand(args.slice(1), deps)
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
