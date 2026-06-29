import { randomUUID } from 'node:crypto'

import { createClient as createWrkqClient } from '@wrkq/client'

import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable } from '../output/table.js'
import { hasFlag, parseArgs } from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type ActionLaunchResponse = {
  source?: string | undefined
  taskId?: string | undefined
  actionRunId?: string | undefined
  wrkfRunId?: string | undefined
  externalRunRef?: string | undefined
  hrcRunId?: string | undefined
  replay?: boolean | undefined
  [key: string]: unknown
}

type ActionLaunchJsonResponse = ActionLaunchResponse & {
  cli: {
    action: string
    taskId: string
    projectId: string
    idempotencyKey: string
    forced: boolean
  }
}

function requireOneTaskId(positionals: readonly string[]): string {
  if (positionals.length !== 1) {
    throw new CliUsageError('usage: acp action triage <taskId>')
  }

  const taskId = positionals[0]?.trim()
  if (taskId === undefined || taskId.length === 0) {
    throw new CliUsageError('taskId is required')
  }
  return taskId
}

function buildIdempotencyKey(input: {
  action: string
  taskId: string
  force: boolean
}): string {
  const stable = `task:${input.taskId}:action:${input.action}`
  return input.force ? `${stable}:force:${Date.now()}:${randomUUID()}` : stable
}

function hrcRunIdFrom(response: ActionLaunchResponse): string | undefined {
  if (typeof response.hrcRunId === 'string' && response.hrcRunId.length > 0) {
    return response.hrcRunId
  }

  const externalRunRef = response.externalRunRef
  if (typeof externalRunRef === 'string' && externalRunRef.startsWith('hrc:')) {
    return externalRunRef.slice('hrc:'.length)
  }

  return undefined
}

function renderActionLaunchText(response: ActionLaunchJsonResponse): string {
  return renderKeyValueTable({
    action: response.cli.action,
    taskId: response.cli.taskId,
    projectId: response.cli.projectId,
    forced: response.cli.forced,
    replay: response.replay ?? false,
    idempotencyKey: response.cli.idempotencyKey,
    actionRunId: response.actionRunId ?? '',
    wrkfRunId: response.wrkfRunId ?? '',
    externalRunRef: response.externalRunRef ?? '',
    hrcRunId: hrcRunIdFrom(response) ?? '',
  })
}

async function resolveTaskProjectId(taskId: string, deps: CommandDependencies): Promise<string> {
  const client =
    deps.createWorkClient !== undefined
      ? await deps.createWorkClient()
      : await createWrkqClient({
          command: 'wrkq',
          clientInfo: { name: 'acp-cli', version: '0.1.0' },
          ...(deps.env !== undefined ? { env: deps.env } : {}),
        })

  try {
    const task = await client.wrkq.task.show({ task: taskId })
    const container = await client.wrkq.container.show({ project: task.projectUuid })
    const projectId = container.id.trim()
    if (projectId.length === 0) {
      throw new CliUsageError(`could not resolve project for task ${taskId}`)
    }
    return projectId
  } finally {
    await client.close()
  }
}

export async function runActionCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--force', '--json'],
    stringFlags: ['--server', '--actor'],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('action help is handled by the top-level CLI')
  }

  if (subcommand !== 'triage') {
    throw new CliUsageError(`unknown action subcommand: ${subcommand ?? ''}`)
  }

  const taskId = requireOneTaskId(parsed.positionals)
  const projectId = await resolveTaskProjectId(taskId, deps)
  const forced = hasFlag(parsed, '--force')
  const idempotencyKey = buildIdempotencyKey({ action: 'triage', taskId, force: forced })
  const response = await createRawRequesterFromParsed(
    parsed,
    deps
  ).requestJson<ActionLaunchResponse>({
    method: 'POST',
    path: '/v1/wrkf/actions/launch',
    body: {
      taskId,
      action: 'triage',
      idempotencyKey,
      sessionRef: {
        scopeRef: `agent:clod:project:${projectId}:task:${taskId}`,
        laneRef: 'main',
      },
    },
  })

  const output: ActionLaunchJsonResponse = {
    ...response,
    cli: {
      action: 'triage',
      taskId,
      projectId,
      idempotencyKey,
      forced,
    },
  }

  return hasFlag(parsed, '--json') ? asJson(output) : asText(renderActionLaunchText(output))
}
