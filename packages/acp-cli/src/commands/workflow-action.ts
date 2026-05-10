import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  parseJsonObject,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type WorkflowActionResponse = {
  task: {
    taskId: string
    state: { status: string; phase?: string | null | undefined; outcome?: string | undefined }
    version: number
  }
}

export async function runWorkflowActionCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: [
      '--task',
      '--actor',
      '--supervisor-run',
      '--action',
      '--capabilities',
      '--expected-version',
      '--context-hash',
      '--idempotency-key',
      '--server',
    ],
  })
  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps, { requireActor: true })
  const body = {
    supervisorRunId: requireStringFlag(parsed, '--supervisor-run'),
    action: parseJsonObject('--action', requireStringFlag(parsed, '--action')),
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(readStringFlag(parsed, '--expected-version') !== undefined
      ? {
          expectedTaskVersion: parseIntegerValue(
            '--expected-version',
            requireStringFlag(parsed, '--expected-version'),
            { min: 0 }
          ),
        }
      : {}),
    ...(readStringFlag(parsed, '--context-hash') !== undefined
      ? { contextHash: requireStringFlag(parsed, '--context-hash') }
      : {}),
  }

  const response = await requester.requestJson<WorkflowActionResponse>({
    method: 'POST',
    path: `/v1/tasks/${encodeURIComponent(requireStringFlag(parsed, '--task'))}/actions`,
    body,
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  const phase = response.task.state.phase ?? response.task.state.outcome ?? 'none'
  return asText(
    `Applied workflow action to ${response.task.taskId}; state=${response.task.state.status}/${phase} version=${response.task.version}`
  )
}
