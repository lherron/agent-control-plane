import { randomUUID } from 'node:crypto'

import { inferProjectIdFromCwd } from 'spaces-config'

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
  type AttachDescriptor,
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawAcpRequester,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

// Task IDs come in two forms: wrkq tasks (`T-01410`, all digits) and workflow
// tasks (`T-0693E836`, 8 uppercase hex chars from createTaskId). Accept both.
const BARE_TASK_PATTERN = /^T-[A-Za-z0-9]+$/

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

async function defaultAttach(descriptor: AttachDescriptor): Promise<number> {
  if (!Array.isArray(descriptor.argv) || descriptor.argv.length === 0) {
    throw new CliUsageError('attach descriptor missing argv')
  }
  const [bin, ...rest] = descriptor.argv as [string, ...string[]]
  const proc = Bun.spawn([bin, ...rest], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await proc.exited
}

type InteractResponse = {
  sessionId: string
  runtimeId: string
  attachDescriptor?: AttachDescriptor
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

  // Project inference: ASP_PROJECT env → walk-up asp-targets.toml marker → fail.
  const projectId = inferProjectIdFromCwd({ env })
  if (projectId === undefined || projectId.trim().length === 0) {
    throw new CliUsageError(
      'cannot infer project; set ASP_PROJECT or provide a fully qualified target'
    )
  }

  // Parse positional target.
  // Filter out stringified 'undefined' from commander's optional argument handling.
  const rawPositional = parsed.positionals[0]
  const positional =
    rawPositional !== undefined && rawPositional !== 'undefined' ? rawPositional : undefined
  let supervisorAgentId: string | undefined
  let taskId: string | undefined

  if (positional !== undefined) {
    if (BARE_TASK_PATTERN.test(positional)) {
      // Bare T-XXXXX: use as taskId, supervisor comes from --supervisor or project default.
      taskId = positional
    } else {
      // Parse as agent-scope shorthand.
      const scope = normalizeScopeInput(positional)
      const parts = scope.scopeRef.split(':')
      if (parts[0] === 'agent' && parts[1]) {
        supervisorAgentId = parts[1]
      }
      const taskIndex = parts.indexOf('task')
      if (taskIndex !== -1 && parts[taskIndex + 1]) {
        taskId = parts[taskIndex + 1]
      }
    }
  }

  // Handle --supervisor flag.
  const supervisorFlag = readStringFlag(parsed, '--supervisor')
  if (supervisorFlag !== undefined) {
    const scope = normalizeScopeInput(supervisorFlag)
    const parts = scope.scopeRef.split(':')
    if (parts[0] === 'agent' && parts[1]) {
      supervisorAgentId = parts[1]
    }
  }

  // Resolve supervisor: explicit flag/positional > project default.
  // Done BEFORE the create-and-interact path so the supervisor identity can be
  // included in the workflow-supervisor-runs body.
  if (supervisorAgentId === undefined) {
    const projectResponse = await requester.requestJson<ProjectResponse>({
      method: 'GET',
      path: `/v1/admin/projects/${projectId}`,
    })

    if (projectResponse.project.defaultAgentId === undefined) {
      throw new CliUsageError(`no default supervisor agent configured for project ${projectId}`)
    }
    supervisorAgentId = projectResponse.project.defaultAgentId
  }

  // Handle --workflow create-and-interact flow.
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
    const explicitTaskId = readStringFlag(parsed, '--task-id')

    const createBody = {
      supervisor: { kind: 'agent', id: supervisorAgentId },
      autonomy: 'managed',
      idempotencyKey: `acp-workflow-interact-${randomUUID()}`,
      createTask: {
        projectId,
        workflow: workflowRef,
        goal: workflowGoal,
        roleBindings,
        ...(explicitTaskId !== undefined ? { taskId: explicitTaskId } : {}),
      },
    }

    const createResponse = await requester.requestJson<SuperviseCreateResponse>({
      method: 'POST',
      path: '/v1/workflow-supervisor-runs',
      body: createBody,
    })

    taskId = createResponse.task.taskId
  }

  // Build sessionRef.
  let scopeRef = `agent:${supervisorAgentId}:project:${projectId}`
  if (taskId !== undefined) {
    scopeRef += `:task:${taskId}`
  }

  const sessionRef = {
    scopeRef,
    laneRef: 'lane:main',
  }

  // Build interact body.
  const interactBody: Record<string, unknown> = {
    sessionRef,
    workflowInteract: true,
  }

  if (taskId !== undefined) {
    interactBody['workflowTaskId'] = taskId
  }

  if (workflowRef !== undefined) {
    // Server expects the env-passthrough form `<id>@<version>` (string), not
    // the structured `{ id, version }` shape used by workflow-supervisor-runs.
    interactBody['workflowRef'] = `${workflowRef.id}@${workflowRef.version}`
  }

  if (workflowGoal !== undefined) {
    interactBody['workflowGoal'] = workflowGoal
  }

  // POST /v1/workflow-interact-runs.
  const response = await requester.requestJson<InteractResponse>({
    method: 'POST',
    path: '/v1/workflow-interact-runs',
    body: interactBody,
  })

  if (hasFlag(parsed, '--json')) {
    return asJson(response)
  }

  const summaryLines = [
    'Interactive session started',
    `  scope:   ${scopeRef}`,
    `  runtime: ${response.runtimeId}`,
    `  attach:  ${response.attachDescriptor?.argv?.join(' ') ?? '(no attach descriptor)'}`,
  ]

  if (hasFlag(parsed, '--detach')) {
    return asText(summaryLines.join('\n'))
  }

  // Default: auto-attach using the descriptor. Print the summary first so the
  // operator can see what happened if the attach fails or the descriptor is
  // missing.
  if (response.attachDescriptor === undefined) {
    return asText(summaryLines.join('\n'))
  }

  const attachFn = deps.attach ?? defaultAttach
  await attachFn(response.attachDescriptor)
  return asText(summaryLines.join('\n'))
}
