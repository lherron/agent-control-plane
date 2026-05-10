import { CliUsageError } from '../cli-runtime.js'
import { normalizeScopeInput } from '../scope-input.js'
import {
  hasFlag,
  parseArgs,
  parseIntegerValue,
  readMultiStringFlag,
  readStringFlag,
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

const BARE_TASK_PATTERN = /^T-\d+$/

function parseWorkflowRef(value: string): { id: string; version: number } {
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) {
    throw new CliUsageError('--workflow must use id@version, for example code_feature_tdd@1')
  }
  return {
    id: value.slice(0, at),
    version: parseIntegerValue('--workflow', value.slice(at + 1), { min: 1 }),
  }
}

function parseRoleBindings(values: string[]): Record<string, { kind: string; id: string }> {
  const bindings: Record<string, { kind: string; id: string }> = {}
  for (const value of values) {
    const separator = value.includes('=') ? value.indexOf('=') : value.indexOf(':')
    if (separator <= 0 || separator === value.length - 1) {
      throw new CliUsageError('--bind must use role=agent:<id> or role=agentId')
    }
    const role = value.slice(0, separator)
    if (bindings[role] !== undefined) {
      throw new CliUsageError(`duplicate role assignment for ${role}`)
    }
    const actorPart = value.slice(separator + 1)
    const actorColon = actorPart.indexOf(':')
    if (actorColon > 0 && actorColon < actorPart.length - 1) {
      bindings[role] = { kind: actorPart.slice(0, actorColon), id: actorPart.slice(actorColon + 1) }
    } else {
      bindings[role] = { kind: 'agent', id: actorPart }
    }
  }
  return bindings
}

type InteractResponse = {
  sessionId: string
  runtimeId: string
  attachDescriptor?: {
    transport: string
    argv: string[]
    bindingFence?: unknown
  }
}

type ProjectResponse = {
  project: {
    projectId: string
    displayName: string
    defaultAgentId?: string
  }
}

type SuperviseCreateResponse = {
  task: {
    taskId: string
    state: { status: string; phase?: string | null | undefined }
    version: number
  }
  supervisorRun: { runId: string; contextHash: string }
  context: Record<string, unknown>
}

export async function runWorkflowInteractCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--detach'],
    stringFlags: ['--supervisor', '--workflow', '--goal', '--task-id', '--server', '--actor'],
    multiStringFlags: ['--bind'],
  })

  const env = resolveEnv(deps)
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const requester = createRawAcpRequester({
    serverUrl: resolveServerUrl(readStringFlag(parsed, '--server'), env),
    ...(actorAgentId !== undefined ? { actorAgentId } : {}),
    fetchImpl: deps.fetchImpl,
  })

  // Infer project from env
  const projectId = env['ASP_PROJECT']
  if (projectId === undefined || projectId.trim().length === 0) {
    throw new CliUsageError(
      'cannot infer project; set ASP_PROJECT or provide a fully qualified target'
    )
  }

  // Parse positional target
  // Filter out stringified 'undefined' from commander's optional argument handling
  const rawPositional = parsed.positionals[0]
  const positional =
    rawPositional !== undefined && rawPositional !== 'undefined' ? rawPositional : undefined
  let supervisorAgentId: string | undefined
  let taskId: string | undefined

  if (positional !== undefined) {
    if (BARE_TASK_PATTERN.test(positional)) {
      // Bare T-XXXXX: use as taskId, supervisor comes from --supervisor or project default
      taskId = positional
    } else {
      // Parse as agent-scope shorthand
      const scope = normalizeScopeInput(positional)
      // Extract agent, project, and thread/task from the scopeRef
      // Format: agent:<agentId>[:project:<projectId>[:task:<taskId>]]
      const parts = scope.scopeRef.split(':')
      // agent:<id>
      if (parts[0] === 'agent' && parts[1]) {
        supervisorAgentId = parts[1]
      }
      // Check for :task: segment (scope-input uses "task" not "thread")
      const taskIndex = parts.indexOf('task')
      if (taskIndex !== -1 && parts[taskIndex + 1]) {
        taskId = parts[taskIndex + 1]
      }
    }
  }

  // Handle --supervisor flag
  const supervisorFlag = readStringFlag(parsed, '--supervisor')
  if (supervisorFlag !== undefined) {
    const scope = normalizeScopeInput(supervisorFlag)
    const parts = scope.scopeRef.split(':')
    if (parts[0] === 'agent' && parts[1]) {
      supervisorAgentId = parts[1]
    }
  }

  // Handle --workflow create-and-interact flow
  const workflowRaw = readStringFlag(parsed, '--workflow')
  let workflowRef: { id: string; version: number } | undefined
  let workflowGoal: string | undefined

  if (workflowRaw !== undefined) {
    const goal = readStringFlag(parsed, '--goal')
    if (goal === undefined || goal.trim().length === 0) {
      throw new CliUsageError('--goal is required when --workflow is provided')
    }
    workflowRef = parseWorkflowRef(workflowRaw)
    workflowGoal = goal

    const bindValues = readMultiStringFlag(parsed, '--bind')
    const roleBindings = parseRoleBindings(bindValues)

    // POST to /v1/workflow-supervisor-runs to create the task
    const createBody = {
      createTask: {
        projectId,
        workflow: workflowRef,
        goal: workflowGoal,
        roleBindings,
      },
    }

    const createResponse = await requester.requestJson<SuperviseCreateResponse>({
      method: 'POST',
      path: '/v1/workflow-supervisor-runs',
      body: createBody,
    })

    // Use the created task's ID for the interact run
    taskId = createResponse.task.taskId
  }

  // Resolve supervisor: explicit flag > positional > project default
  if (supervisorAgentId === undefined) {
    // Look up project default supervisor
    const projectResponse = await requester.requestJson<ProjectResponse>({
      method: 'GET',
      path: `/v1/admin/projects/${projectId}`,
    })

    if (projectResponse.project.defaultAgentId === undefined) {
      throw new CliUsageError(`no default supervisor agent configured for project ${projectId}`)
    }
    supervisorAgentId = projectResponse.project.defaultAgentId
  }

  // Build sessionRef
  let scopeRef = `agent:${supervisorAgentId}:project:${projectId}`
  if (taskId !== undefined) {
    scopeRef += `:thread:${taskId}`
  }

  const sessionRef = {
    scopeRef,
    laneRef: 'lane:main',
  }

  // Build interact body
  const interactBody: Record<string, unknown> = {
    sessionRef,
    workflowInteract: true,
  }

  if (taskId !== undefined) {
    interactBody['workflowTaskId'] = taskId
  }

  if (workflowRef !== undefined) {
    interactBody['workflowRef'] = workflowRef
  }

  if (workflowGoal !== undefined) {
    interactBody['workflowGoal'] = workflowGoal
  }

  // POST /v1/workflow-interact-runs
  const response = await requester.requestJson<InteractResponse>({
    method: 'POST',
    path: '/v1/workflow-interact-runs',
    body: interactBody,
  })

  // Output handling
  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  if (hasFlag(parsed, '--detach')) {
    const lines = [
      'Interactive session started',
      `  scope:   ${scopeRef}`,
      `  runtime: ${response.runtimeId}`,
      `  attach:  ${response.attachDescriptor?.argv?.join(' ') ?? '(no attach descriptor)'}`,
    ]
    return asText(lines.join('\n'))
  }

  // Default: also print attach info (in real usage would attach)
  const lines = [
    'Interactive session started',
    `  scope:   ${scopeRef}`,
    `  runtime: ${response.runtimeId}`,
    `  attach:  ${response.attachDescriptor?.argv?.join(' ') ?? '(no attach descriptor)'}`,
  ]
  return asText(lines.join('\n'))
}
