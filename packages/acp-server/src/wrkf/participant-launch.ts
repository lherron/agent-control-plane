import type { Actor } from 'acp-core'
import type { SessionRef } from 'agent-scope'

import type {
  AdminStore,
  AgentRootResolver,
  LaunchRoleScopedRun,
  RuntimeResolver,
} from '../deps.js'
import type { RunStore } from '../domain/run-store.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import type { AcpWrkfWorkflowPort } from './port.js'

export type WrkfParticipantLaunchInput = {
  taskId: string
  role: string
  actor?: Actor | undefined
  idempotencyKey: string
  sessionRef: SessionRef
  initialPrompt?: string | undefined
}

export type WrkfParticipantLaunchDeps = {
  wrkf: AcpWrkfWorkflowPort
  runStore: RunStore
  launchRoleScopedRun: LaunchRoleScopedRun
  runtimeResolver?: RuntimeResolver | undefined
  agentRootResolver?: AgentRootResolver | undefined
  adminStore?: AdminStore | undefined
}

export type WrkfLaunchInfo = {
  runId: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  launchId?: string | undefined
  generation?: number | undefined
}

export type WrkfParticipantLaunchResult = {
  source: 'wrkf'
  taskId: string
  instanceId: string
  workflowRef: string
  revision: number
  contextHash?: string | undefined
  wrkfRun: Record<string, unknown>
  launch?: WrkfLaunchInfo | undefined
  replay: boolean
}

type WrkfProjection = {
  task: Record<string, unknown>
  instance: Record<string, unknown>
  next: unknown
  instanceId: string
  workflowRef: string
  revision: number
  contextHash?: string | undefined
}

export async function launchParticipant(
  deps: WrkfParticipantLaunchDeps,
  input: WrkfParticipantLaunchInput
): Promise<WrkfParticipantLaunchResult> {
  const inspected = await deps.wrkf.task.inspect({ task: input.taskId })
  const next = await deps.wrkf.next({ task: input.taskId })
  const projection = projectWrkfLaunchContext(input.taskId, inspected, next)
  const wrkfRun = asRecord(
    await deps.wrkf.run.start({
      task: input.taskId,
      role: input.role,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      idempotencyKey: input.idempotencyKey,
    }),
    'wrkf.run.start result'
  )

  if (typeof wrkfRun['externalRunRef'] === 'string' && wrkfRun['externalRunRef'].length > 0) {
    return buildResult(input.taskId, projection, wrkfRun, { replay: true })
  }

  const wrkfRunId = readRequiredString(wrkfRun, 'id', 'wrkf.run.start result')
  const { run: acpRun, created } = deps.runStore.createOrGetRun({
    sessionRef: input.sessionRef,
    wrkfTaskId: input.taskId,
    wrkfInstanceId: projection.instanceId,
    wrkfRunId,
    workflowRef: projection.workflowRef,
    role: input.role,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  })

  if (!created && acpRun.hrcRunId !== undefined) {
    await deps.wrkf.run.bindExternal({
      runId: wrkfRunId,
      externalRunRef: acpRun.hrcRunId,
      deliveryRef: stableJson({
        kind: 'hrc',
        runId: acpRun.hrcRunId,
        hostSessionId: acpRun.hostSessionId,
        runtimeId: acpRun.runtimeId,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        generation: acpRun.generation,
      }),
      idempotencyKey: `${input.idempotencyKey}:bindExternal`,
    })
    return buildResult(input.taskId, projection, wrkfRun, { replay: false })
  }

  const prompt = input.initialPrompt ?? buildParticipantPrompt({ input, projection, wrkfRun })
  const intent = await resolveLaunchIntent(
    deps as Parameters<typeof resolveLaunchIntent>[0],
    input.sessionRef,
    { initialPrompt: prompt }
  )
  const launched = await deps.launchRoleScopedRun({
    sessionRef: input.sessionRef,
    intent,
    acpRunId: acpRun.runId,
    runStore: deps.runStore,
    waitForCompletion: false,
  })
  const launchInfo = toLaunchInfo(launched)

  deps.runStore.updateRun(acpRun.runId, {
    hrcRunId: launched.runId,
    ...(launched.hostSessionId !== undefined ? { hostSessionId: launched.hostSessionId } : {}),
    ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
    ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
    transport: 'hrc',
  })

  await deps.wrkf.run.bindExternal({
    runId: wrkfRunId,
    externalRunRef: launched.runId,
    deliveryRef: stableJson({
      kind: 'hrc',
      runId: launched.runId,
      hostSessionId: launched.hostSessionId,
      runtimeId: launched.runtimeId,
      launchId: launched.launchId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      generation: launched.generation,
    }),
    idempotencyKey: `${input.idempotencyKey}:bindExternal`,
  })

  return buildResult(input.taskId, projection, wrkfRun, {
    launch: launchInfo,
    replay: false,
  })
}

function buildResult(
  taskId: string,
  projection: WrkfProjection,
  wrkfRun: Record<string, unknown>,
  options: { launch?: WrkfLaunchInfo | undefined; replay: boolean }
): WrkfParticipantLaunchResult {
  return {
    source: 'wrkf',
    taskId,
    instanceId: projection.instanceId,
    workflowRef: projection.workflowRef,
    revision: projection.revision,
    ...(projection.contextHash !== undefined ? { contextHash: projection.contextHash } : {}),
    wrkfRun,
    ...(options.launch !== undefined ? { launch: options.launch } : {}),
    replay: options.replay,
  }
}

function projectWrkfLaunchContext(
  taskId: string,
  inspected: unknown,
  next: unknown
): WrkfProjection {
  const inspectedRecord = isRecord(inspected) ? inspected : {}
  const nextRecord = isRecord(next) ? next : {}
  const task = isRecord(inspectedRecord['task'])
    ? inspectedRecord['task']
    : projectFlatWrkfTask(taskId, inspectedRecord)
  const instance = isRecord(inspectedRecord['instance'])
    ? inspectedRecord['instance']
    : isRecord(nextRecord['instance'])
      ? nextRecord['instance']
      : projectFlatWrkfInstance(taskId, inspectedRecord)

  const instanceId =
    readOptionalString(instance, 'instanceId') ??
    readOptionalString(instance, 'id') ??
    readOptionalString(inspectedRecord, 'instanceId') ??
    readOptionalString(inspectedRecord, 'id') ??
    taskId
  const workflowRef =
    readOptionalString(instance, 'workflowRef') ??
    readOptionalString(instance, 'workflowId') ??
    readOptionalString(inspectedRecord, 'templateId') ??
    'unknown'
  const revision =
    readOptionalNumber(instance, 'revision') ??
    readOptionalNumber(inspectedRecord, 'revision') ??
    readOptionalNumber(task, 'version') ??
    0
  const contextHash =
    readOptionalString(instance, 'contextHash') ??
    readOptionalString(inspectedRecord, 'contextHash')

  return {
    task,
    instance,
    next,
    instanceId,
    workflowRef,
    revision,
    ...(contextHash !== undefined ? { contextHash } : {}),
  }
}

function projectFlatWrkfTask(
  taskId: string,
  inspected: Record<string, unknown>
): Record<string, unknown> {
  return {
    taskId,
    projectId: readOptionalString(inspected, 'projectId') ?? '',
    status: readOptionalString(inspected, 'status') ?? 'unknown',
    version: readOptionalNumber(inspected, 'revision') ?? 0,
  }
}

function projectFlatWrkfInstance(
  taskId: string,
  inspected: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: readOptionalString(inspected, 'id') ?? taskId,
    taskRef: readOptionalString(inspected, 'taskRef') ?? taskId,
    workflowRef: readOptionalString(inspected, 'templateId') ?? 'unknown',
    revision: readOptionalNumber(inspected, 'revision') ?? 0,
    ...(readOptionalString(inspected, 'contextHash') !== undefined
      ? { contextHash: readOptionalString(inspected, 'contextHash') }
      : {}),
  }
}

function buildParticipantPrompt(input: {
  input: WrkfParticipantLaunchInput
  projection: WrkfProjection
  wrkfRun: Record<string, unknown>
}): string {
  return [
    'You are starting an ACP workflow participant run.',
    'Use the wrkf projection below as the authoritative task contract and continue autonomously within your role.',
    '',
    stableJson({
      taskId: input.input.taskId,
      role: input.input.role,
      task: input.projection.task,
      instance: input.projection.instance,
      next: input.projection.next,
      wrkfRun: input.wrkfRun,
    }),
  ].join('\n')
}

function toLaunchInfo(launched: Awaited<ReturnType<LaunchRoleScopedRun>>): WrkfLaunchInfo {
  return {
    runId: launched.runId,
    ...(launched.hostSessionId !== undefined ? { hostSessionId: launched.hostSessionId } : {}),
    ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
    ...(launched.launchId !== undefined ? { launchId: launched.launchId } : {}),
    ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry))
  }
  if (!isRecord(value)) {
    return value
  }

  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const next = value[key]
    if (next !== undefined) {
      sorted[key] = sortJson(next)
    }
  }
  return sorted
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function readRequiredString(input: Record<string, unknown>, field: string, label: string): string {
  const value = readOptionalString(input, field)
  if (value === undefined) {
    throw new Error(`${label}.${field} must be a non-empty string`)
  }
  return value
}

function readOptionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOptionalNumber(input: Record<string, unknown>, field: string): number | undefined {
  const value = input[field]
  return typeof value === 'number' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
