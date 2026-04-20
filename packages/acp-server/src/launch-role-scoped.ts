import { computeTaskContext } from 'acp-core'
import { type SessionRef, parseScopeRef } from 'agent-scope'
import type { HrcHarnessIntent, HrcRuntimeIntent, HrcTaskContext } from 'hrc-core'

import type { ResolvedAcpServerDeps } from './deps.js'
import { parseSessionRefField, requireTask } from './handlers/shared.js'
import { badRequest, json, notFound, unprocessable } from './http.js'
import { parseJsonBody, requireRecord, requireTrimmedStringField } from './parsers/body.js'

import type { RouteHandler } from './routing/route-context.js'

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

  const placement = await resolveLaunchPlacement(deps, input.sessionRef)
  const harness = readLaunchHarness(placement)
  const intent = {
    placement,
    ...(harness !== undefined ? { harness } : {}),
    taskContext,
  } as HrcRuntimeIntent

  const launched = await deps.launchRoleScopedRun({
    sessionRef: input.sessionRef,
    intent,
  })

  return {
    ...launched,
    intent,
  }
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
  deps: ResolvedAcpServerDeps,
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
  const bundle = readOptionalBundle(resolvedPlacement)

  return {
    ...(resolvedPlacement ?? {}),
    agentRoot,
    runMode: readOptionalString(resolvedPlacement, 'runMode') ?? 'task',
    bundle: bundle ?? { kind: 'agent-default' },
    correlation: {
      ...(rawCorrelation ?? {}),
      sessionRef,
    },
  } as HrcRuntimeIntent['placement']
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

function readOptionalString(
  input: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  const value = input?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalRecord(
  input: Record<string, unknown> | undefined,
  field: string
): Record<string, unknown> | undefined {
  const value = input?.[field]
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
