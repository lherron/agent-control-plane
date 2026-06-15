import { type AttachmentRef, computeTaskContext } from 'acp-core'
import { type SessionRef, parseScopeRef } from 'agent-scope'
import type { HrcHarnessIntent, HrcRuntimeIntent, HrcTaskContext } from 'hrc-core'
import { buildRuntimeBundleRef } from 'spaces-config'

import type { ResolvedAcpServerDeps } from './deps.js'
import { parseSessionRefField, requireTask } from './handlers/shared.js'
import { badRequest, json, notFound, unprocessable } from './http.js'
import {
  readOptionalPlainRecord as readOptionalRecord,
  readOptionalNonEmptyString as readOptionalString,
} from './internal/read-helpers.js'
import {
  isRecord,
  parseJsonBody,
  requireRecord,
  requireTrimmedStringField,
} from './parsers/body.js'

import type { RouteHandler } from './routing/route-context.js'

// Narrow dependency surface for launch placement/intent resolution.
// Call sites without full ResolvedAcpServerDeps (queue + wake dispatchers)
// must still provide adminStore so admin-project-root lookups apply to cwd.
export type LaunchIntentDeps = Pick<
  ResolvedAcpServerDeps,
  'runtimeResolver' | 'agentRootResolver' | 'adminStore'
>

export type LaunchRoleScopedTaskRunInput = {
  sessionRef: SessionRef
  taskId: string
  role: string
}

export async function launchRoleScopedTaskRun(
  deps: ResolvedAcpServerDeps,
  input: LaunchRoleScopedTaskRunInput
): Promise<{ runId: string; sessionId: string; intent: HrcRuntimeIntent }> {
  if (deps.launchRoleScopedRun === undefined) {
    throw new Error('acp-server launchRoleScopedRun: no launcher wired')
  }

  const task = requireTask(deps.wrkqStore.taskRepo.getTask(input.taskId), input.taskId)
  if (task.workflowPreset === undefined || task.presetVersion === undefined) {
    unprocessable(
      'workflow_preset_required',
      `task ${input.taskId} is not pinned to a workflow preset`,
      { taskId: input.taskId }
    )
  }

  const roleMap = deps.wrkqStore.roleAssignmentRepo.getRoleMap(input.taskId) ?? task.roleMap
  const assignedAgentId = roleMap[input.role]?.trim()
  if (!assignedAgentId) {
    unprocessable(
      'role_assignment_missing',
      `task ${input.taskId} has no assignee for role ${input.role}`,
      { taskId: input.taskId, role: input.role }
    )
  }

  const parsedScope = parseScopeRef(input.sessionRef.scopeRef)
  if (parsedScope.projectId !== undefined && parsedScope.projectId !== task.projectId) {
    badRequest('sessionRef projectId must match task.projectId', {
      field: 'sessionRef.scopeRef',
      expectedProjectId: task.projectId,
      actualProjectId: parsedScope.projectId,
    })
  }

  if (parsedScope.taskId !== undefined && parsedScope.taskId !== input.taskId) {
    badRequest('sessionRef taskId must match taskId', {
      field: 'sessionRef.scopeRef',
      expectedTaskId: input.taskId,
      actualTaskId: parsedScope.taskId,
    })
  }

  if (parsedScope.roleName !== undefined && parsedScope.roleName !== input.role) {
    badRequest('sessionRef role must match role', {
      field: 'sessionRef.scopeRef',
      expectedRole: input.role,
      actualRole: parsedScope.roleName,
    })
  }

  if (parsedScope.agentId !== assignedAgentId) {
    unprocessable(
      'role_assignment_mismatch',
      `sessionRef agent ${parsedScope.agentId} does not match assignee ${assignedAgentId} for role ${input.role}`,
      {
        field: 'sessionRef.scopeRef',
        role: input.role,
        expectedAgentId: assignedAgentId,
        actualAgentId: parsedScope.agentId,
      }
    )
  }

  const preset = deps.presetRegistry.getPreset(task.workflowPreset, task.presetVersion)
  const computedContext = computeTaskContext({
    preset,
    task: { ...task, roleMap },
    role: input.role,
  })
  const taskContext: HrcTaskContext = {
    taskId: input.taskId,
    phase: computedContext.phase,
    role: input.role,
    requiredEvidenceKinds: [...computedContext.requiredEvidenceKinds],
    hintsText: computedContext.hintsText,
  }

  const intent = await resolveLaunchIntent(deps, input.sessionRef, { taskContext })

  const launched = await deps.launchRoleScopedRun({
    sessionRef: input.sessionRef,
    intent,
  })

  return {
    ...launched,
    intent,
  }
}

export async function resolveLaunchIntent(
  deps: LaunchIntentDeps,
  sessionRef: SessionRef,
  options: {
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    /**
     * Extra environment variables injected into the launched runtime via
     * intent.launch.env. The PBC continuation worker uses this to pass the
     * participant's TRUSTED actor/role binding (WRKF_BOUND_ACTOR/ROLE) and task
     * so the agent can call `wrkf` directly as itself without being able to
     * impersonate (paired with wrkq T-03777 E2). Merged over any placement env.
     */
    env?: Record<string, string> | undefined
  } = {}
): Promise<HrcRuntimeIntent> {
  const placement = await resolveLaunchPlacement(deps, sessionRef)
  const harness = readLaunchHarness(placement)

  return {
    placement,
    ...(harness !== undefined ? { harness } : {}),
    ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
    ...(options.attachments !== undefined ? { attachments: options.attachments } : {}),
    ...(options.taskContext !== undefined ? { taskContext: options.taskContext } : {}),
    ...(options.env !== undefined ? { launch: { env: options.env } } : {}),
  } as HrcRuntimeIntent
}

export const handleLaunchSession: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const result = await launchRoleScopedTaskRun(deps, {
    sessionRef,
    taskId: requireTrimmedStringField(body, 'taskId'),
    role: requireTrimmedStringField(body, 'role'),
  })

  return json({
    runId: result.runId,
    sessionId: result.sessionId,
  })
}

async function resolveLaunchPlacement(
  deps: LaunchIntentDeps,
  sessionRef: SessionRef
): Promise<HrcRuntimeIntent['placement']> {
  const resolvedPlacement = deps.runtimeResolver
    ? await deps.runtimeResolver(sessionRef)
    : undefined
  const parsedScope = parseScopeRef(sessionRef.scopeRef)
  const fallbackAgentRoot = deps.agentRootResolver
    ? await deps.agentRootResolver({ agentId: parsedScope.agentId, sessionRef })
    : undefined

  const agentRoot = readOptionalString(resolvedPlacement, 'agentRoot') ?? fallbackAgentRoot
  if (agentRoot === undefined) {
    notFound(`runtime placement not found for ${sessionRef.scopeRef}`, {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
    })
  }

  const rawCorrelation = readOptionalRecord(resolvedPlacement, 'correlation')
  const resolvedBundle = readOptionalBundle(resolvedPlacement)
  const resolvedProjectRoot = readOptionalString(resolvedPlacement, 'projectRoot')
  const adminProjectRoot = readAdminProjectRoot(deps, parsedScope.projectId)
  const projectRoot = adminProjectRoot ?? resolvedProjectRoot
  const resolvedCwd = readOptionalString(resolvedPlacement, 'cwd')
  const cwd =
    adminProjectRoot !== undefined ? adminProjectRoot : (resolvedCwd ?? projectRoot ?? agentRoot)
  const bundle = shouldRebuildDefaultBundle(resolvedBundle, adminProjectRoot)
    ? buildRuntimeBundleRef({
        agentName: parsedScope.agentId,
        agentRoot,
        projectRoot: adminProjectRoot,
      })
    : (resolvedBundle ?? { kind: 'compose', compose: [] })

  return {
    ...(resolvedPlacement ?? {}),
    agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd,
    runMode: readOptionalString(resolvedPlacement, 'runMode') ?? 'task',
    bundle,
    correlation: {
      ...(rawCorrelation ?? {}),
      sessionRef,
    },
  } as HrcRuntimeIntent['placement']
}

function readAdminProjectRoot(
  deps: LaunchIntentDeps,
  projectId: string | undefined
): string | undefined {
  if (projectId === undefined) {
    return undefined
  }

  // Defensive optional chaining: some test fixtures cast bare objects to
  // ResolvedAcpServerDeps without populating adminStore.
  const project = deps.adminStore?.projects.get(projectId)
  const rootDir = project?.homeDir ?? project?.rootDir
  return typeof rootDir === 'string' && rootDir.length > 0 ? rootDir : undefined
}

function shouldRebuildDefaultBundle(
  bundle: HrcRuntimeIntent['placement']['bundle'] | undefined,
  adminProjectRoot: string | undefined
): boolean {
  if (adminProjectRoot === undefined) {
    return false
  }

  return bundle === undefined || (bundle.kind === 'compose' && bundle.compose.length === 0)
}

function readLaunchHarness(placement: unknown): HrcHarnessIntent | undefined {
  const record = isRecord(placement) ? placement : undefined
  const harness = readOptionalRecord(record, 'harness')
  const provider = harness?.['provider']
  const interactive = harness?.['interactive']
  if ((provider !== 'anthropic' && provider !== 'openai') || typeof interactive !== 'boolean') {
    return undefined
  }

  return {
    provider,
    interactive,
    ...(typeof harness?.['model'] === 'string' ? { model: harness['model'] } : {}),
    ...(harness?.['yolo'] === true ? { yolo: true } : {}),
  }
}

function readOptionalBundle(
  placement: Record<string, unknown> | undefined
): HrcRuntimeIntent['placement']['bundle'] | undefined {
  const bundle = readOptionalRecord(placement, 'bundle')
  if (bundle === undefined || typeof bundle['kind'] !== 'string') {
    return undefined
  }

  return bundle as HrcRuntimeIntent['placement']['bundle']
}
