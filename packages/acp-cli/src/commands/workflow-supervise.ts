import { CliUsageError } from '../cli-runtime.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  parseJsonObject,
  readMultiStringFlag,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawAcpRequester,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

function parseWorkflowRef(value: string): { id: string; version: number } {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) {
    throw new CliUsageError('--workflow must use id@version, for example basic@1')
  }
  return {
    id: value.slice(0, at),
    version: parseIntegerValue('--workflow', value.slice(at + 1), { min: 1 }),
  }
}

function parseActorRef(value: string, flag: string): { kind: string; id: string } {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new CliUsageError(`${flag} cannot be empty`)
  }
  const separator = trimmed.indexOf(':')
  if (separator > 0 && separator < trimmed.length - 1) {
    return { kind: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) }
  }
  return { kind: 'agent', id: trimmed }
}

function parseRoleBindings(values: string[]): Record<string, { kind: string; id: string } | null> {
  const bindings: Record<string, { kind: string; id: string } | null> = {}
  for (const value of values) {
    const separator = value.includes('=') ? value.indexOf('=') : value.indexOf(':')
    if (separator <= 0 || separator === value.length - 1) {
      throw new CliUsageError('--bind must use role=agent:<id> or role:<agentId>')
    }
    const role = value.slice(0, separator)
    if (bindings[role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${role}`)
    }
    bindings[role] = parseActorRef(value.slice(separator + 1), '--bind')
  }
  return bindings
}

function parseHarness(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    return parseJsonObject('--harness', trimmed)
  }
  return { harness: trimmed }
}

type SuperviseResponse = {
  task: {
    taskId: string
    state: { status: string; phase?: string | null | undefined; outcome?: string | undefined }
    version: number
  }
  supervisorRun: { runId: string; contextHash: string }
  context: Record<string, unknown>
}

export async function runWorkflowSuperviseCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--resume'],
    stringFlags: [
      '--task',
      '--workflow',
      '--project',
      '--goal',
      '--risk',
      '--supervisor',
      '--autonomy',
      '--harness',
      '--capabilities',
      '--idempotency-key',
      '--run',
      '--server',
      '--actor',
    ],
    multiStringFlags: ['--bind', '--role'],
  })
  requireNoPositionals(parsed)

  const existingTaskId = readStringFlag(parsed, '--task')
  const workflow = readStringFlag(parsed, '--workflow')
  if (existingTaskId === undefined && workflow === undefined) {
    throw new CliUsageError('provide --task to resume or --workflow with --project and --goal')
  }
  if (existingTaskId !== undefined && workflow !== undefined) {
    throw new CliUsageError('provide either --task or --workflow, not both')
  }

  const supervisor = parseActorRef(requireStringFlag(parsed, '--supervisor'), '--supervisor')
  const env = resolveEnv(deps)
  const actorAgentId =
    resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env) ??
    (supervisor.kind === 'agent' ? supervisor.id : undefined)
  const requester = createRawAcpRequester({
    serverUrl: resolveServerUrl(readStringFlag(parsed, '--server'), env),
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
    fetchImpl: deps.fetchImpl,
  })

  const bindValues = [
    ...readMultiStringFlag(parsed, '--bind'),
    ...readMultiStringFlag(parsed, '--role'),
  ]
  const body = {
    supervisor,
    autonomy: readStringFlag(parsed, '--autonomy') ?? 'managed',
    idempotencyKey: requireStringFlag(parsed, '--idempotency-key'),
    ...(readStringFlag(parsed, '--run') !== undefined
      ? { runId: readStringFlag(parsed, '--run') }
      : {}),
    ...(readStringFlag(parsed, '--capabilities') !== undefined
      ? {
          capabilities: parseJsonObject(
            '--capabilities',
            requireStringFlag(parsed, '--capabilities')
          ),
        }
      : {}),
    ...(parseHarness(readStringFlag(parsed, '--harness')) !== undefined
      ? { harness: parseHarness(readStringFlag(parsed, '--harness')) }
      : {}),
    ...(existingTaskId !== undefined
      ? { taskId: existingTaskId }
      : {
          createTask: {
            projectId: requireStringFlag(parsed, '--project'),
            workflow: parseWorkflowRef(requireStringFlag(parsed, '--workflow')),
            goal: requireStringFlag(parsed, '--goal'),
            ...(readStringFlag(parsed, '--risk') !== undefined
              ? { risk: readStringFlag(parsed, '--risk') }
              : {}),
            roleBindings: parseRoleBindings(bindValues),
          },
        }),
  }

  const response = await requester.requestJson<SuperviseResponse>({
    method: 'POST',
    path: '/v1/workflow-supervisor-runs',
    body,
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  const phase = response.task.state.phase ?? response.task.state.outcome ?? 'none'
  return asText(
    `Supervising ${response.task.taskId} with ${response.supervisorRun.runId}; state=${response.task.state.status}/${phase} version=${response.task.version} context=${response.supervisorRun.contextHash}`
  )
}
