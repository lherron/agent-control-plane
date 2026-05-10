import { randomUUID } from 'node:crypto'

import { conflict, forbidden, json, notFound, unprocessable } from '../http.js'
import { reconcileWorkflowEffectIntents } from '../integration/workflow-effect-reconciler.js'
import { extractActor } from '../parsers/actor.js'
import {
  parseJsonBody,
  readOptionalArrayField,
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireNumberField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  actorRefFromUnknown,
  parseWorkflowControlAction,
  rejectWorkflowResult,
  withDurableWorkflowKernel,
} from '../workflow-runtime.js'

function createTaskId(): string {
  return `T-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

function workflowRefFromBody(body: Record<string, unknown>): { id: string; version: number } {
  const workflow = requireRecord(body['workflow'], 'workflow')
  return {
    id: requireTrimmedStringField(workflow, 'id'),
    version: requireNumberField(workflow, 'version'),
  }
}

function requireTaskId(params: Record<string, string | undefined>): string {
  const taskId = params['taskId']
  if (taskId === undefined || taskId.length === 0) {
    throw new Error('taskId route parameter is required')
  }
  return taskId
}

async function reconcileEffects(deps: Parameters<RouteHandler>[0]['deps']): Promise<void> {
  if (deps.stateStore === undefined) {
    throw new Error('ACP workflow runtime requires stateStore')
  }
  await reconcileWorkflowEffectIntents({ stateStore: deps.stateStore, coordStore: deps.coordStore })
}

export const handleCreateWorkflowTask: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const supervisor = readOptionalRecordField(body, 'supervisor')
  const roleBindings = readOptionalRecordField(body, 'roleBindings')

  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.createTask({
        taskId: readOptionalTrimmedStringField(body, 'taskId') ?? createTaskId(),
        projectId: requireTrimmedStringField(body, 'projectId'),
        workflow: workflowRefFromBody(body),
        goal: requireTrimmedStringField(body, 'goal'),
        ...(readOptionalTrimmedStringField(body, 'risk') !== undefined
          ? { risk: readOptionalTrimmedStringField(body, 'risk') }
          : {}),
        ...(readOptionalRecordField(body, 'initialFacts') !== undefined
          ? { initialFacts: readOptionalRecordField(body, 'initialFacts') }
          : {}),
        ...(roleBindings !== undefined ? { roleBindings: roleBindings as never } : {}),
        ...(supervisor !== undefined
          ? {
              supervisor: {
                actor: actorRefFromUnknown(supervisor['actor'], actor?.agentId),
                autonomy:
                  typeof supervisor['autonomy'] === 'string'
                    ? (supervisor['autonomy'] as never)
                    : 'managed',
                capabilities:
                  readOptionalRecordField(supervisor, 'capabilities') === undefined
                    ? {}
                    : (readOptionalRecordField(supervisor, 'capabilities') as never),
              },
            }
          : {}),
        idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
      }),
    { save: true }
  )

  const response = rejectWorkflowResult(result)
  await reconcileEffects(deps)
  return json(response, 201)
}

export const handleStartWorkflowSupervisorRun: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const supervisor = actorRefFromUnknown(body['supervisor'], actor?.agentId)
  const autonomy =
    readOptionalTrimmedStringField(body, 'autonomy') === undefined
      ? 'managed'
      : (readOptionalTrimmedStringField(body, 'autonomy') as never)
  const capabilities =
    readOptionalRecordField(body, 'capabilities') === undefined
      ? undefined
      : (readOptionalRecordField(body, 'capabilities') as never)
  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')
  const createTask = readOptionalRecordField(body, 'createTask')

  const result = withDurableWorkflowKernel(
    deps,
    (kernel) => {
      let taskId = readOptionalTrimmedStringField(body, 'taskId')
      if (createTask !== undefined) {
        const createResult = kernel.createTask({
          taskId: readOptionalTrimmedStringField(createTask, 'taskId') ?? createTaskId(),
          projectId: requireTrimmedStringField(createTask, 'projectId'),
          workflow: workflowRefFromBody(createTask),
          goal: requireTrimmedStringField(createTask, 'goal'),
          ...(readOptionalTrimmedStringField(createTask, 'risk') !== undefined
            ? { risk: readOptionalTrimmedStringField(createTask, 'risk') }
            : {}),
          ...(readOptionalRecordField(createTask, 'initialFacts') !== undefined
            ? { initialFacts: readOptionalRecordField(createTask, 'initialFacts') }
            : {}),
          ...(readOptionalRecordField(createTask, 'roleBindings') !== undefined
            ? { roleBindings: readOptionalRecordField(createTask, 'roleBindings') as never }
            : {}),
          supervisor: {
            actor: supervisor,
            autonomy,
            capabilities: capabilities ?? {},
          },
          idempotencyKey: `${idempotencyKey}:task`,
        })
        if (!createResult.ok) {
          return createResult
        }
        taskId = createResult.task.taskId
      }

      if (taskId === undefined) {
        throw new Error('taskId or createTask is required')
      }

      return kernel.startSupervisorRun({
        taskId,
        ...(readOptionalTrimmedStringField(body, 'runId') !== undefined
          ? { runId: readOptionalTrimmedStringField(body, 'runId') }
          : {}),
        supervisor,
        autonomy,
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(readOptionalRecordField(body, 'harness') !== undefined
          ? { harness: readOptionalRecordField(body, 'harness') }
          : {}),
        idempotencyKey,
      })
    },
    { save: true }
  )

  const response = rejectWorkflowResult(result)
  await reconcileEffects(deps)
  return json(response, createTask === undefined ? 200 : 201)
}

export const handleGetWorkflowTask: RouteHandler = async ({ params, deps }) => {
  const taskId = requireTaskId(params)
  const result = withDurableWorkflowKernel(deps, (kernel) => {
    const task = kernel.getTask(taskId)
    if (task === undefined) {
      return undefined
    }
    return {
      task,
      events: kernel.listEvents(taskId),
      evidence: kernel.listEvidence(taskId),
      obligations: kernel.listObligations(taskId),
      effects: kernel.listEffectIntents(taskId),
      supervisorRuns: kernel.listSupervisorRuns(taskId),
      participantRuns: kernel.listParticipantRuns(taskId),
      anomalies: kernel.listAnomalies(taskId),
      workflowPatchProposals: kernel.listWorkflowPatchProposals(taskId),
    }
  })
  if (result === undefined) {
    notFound(`workflow task not found: ${taskId}`, { taskId })
  }
  return json(result)
}

export const handleApplyWorkflowTransition: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: true })
  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.applyTransition({
        taskId,
        transitionId: requireTrimmedStringField(body, 'transitionId'),
        actor: actorRefFromUnknown(body['actor'], actor?.agentId),
        role: requireTrimmedStringField(body, 'role'),
        expectedTaskVersion: requireNumberField(body, 'expectedTaskVersion'),
        ...(readOptionalTrimmedStringField(body, 'contextHash') !== undefined
          ? { contextHash: readOptionalTrimmedStringField(body, 'contextHash') }
          : {}),
        ...(readOptionalArrayField(body, 'evidenceRefs') !== undefined
          ? { evidenceRefs: readOptionalArrayField(body, 'evidenceRefs') as string[] }
          : {}),
        ...(readOptionalArrayField(body, 'inlineEvidence') !== undefined
          ? { inlineEvidence: readOptionalArrayField(body, 'inlineEvidence') as never }
          : {}),
        ...(readOptionalTrimmedStringField(body, 'runId') !== undefined
          ? { runId: readOptionalTrimmedStringField(body, 'runId') }
          : {}),
        idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
      }),
    { save: true }
  )
  const response = rejectWorkflowResult(result)
  await reconcileEffects(deps)
  return json(response)
}

export const handleWorkflowControlAction: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.submitControlAction({
        taskId,
        supervisorRunId: requireTrimmedStringField(body, 'supervisorRunId'),
        ...(readOptionalTrimmedStringField(body, 'contextHash') !== undefined
          ? { contextHash: readOptionalTrimmedStringField(body, 'contextHash') }
          : {}),
        ...(body['expectedTaskVersion'] !== undefined
          ? { expectedTaskVersion: requireNumberField(body, 'expectedTaskVersion') }
          : {}),
        ...(readOptionalRecordField(body, 'capabilities') !== undefined
          ? { capabilities: readOptionalRecordField(body, 'capabilities') as never }
          : {}),
        action: parseWorkflowControlAction(body['action']),
        idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
      }),
    { save: true }
  )
  const response = rejectWorkflowResult(result)
  await reconcileEffects(deps)
  return json(response)
}

export const handleWorkflowParticipantContext: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: true })
  const context = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.compileParticipantContext({
        taskId,
        runId: requireTrimmedStringField(body, 'runId'),
        actor: actorRefFromUnknown(body['actor'], actor?.agentId),
        role: requireTrimmedStringField(body, 'role'),
        sessionRef: {
          scopeRef: requireTrimmedStringField(
            requireRecord(body['sessionRef'], 'sessionRef'),
            'scopeRef'
          ),
          laneRef:
            readOptionalTrimmedStringField(
              requireRecord(body['sessionRef'], 'sessionRef'),
              'laneRef'
            ) ?? 'main',
        },
        idempotencyPrefix: requireTrimmedStringField(body, 'idempotencyPrefix'),
      }),
    { save: true }
  )
  return json({ context })
}

export const handleWorkflowSupervisorContext: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: true })
  const context = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.compileSupervisorContext({
        taskId,
        runId: requireTrimmedStringField(body, 'runId'),
        actor: actorRefFromUnknown(body['actor'], actor?.agentId),
        autonomy:
          readOptionalTrimmedStringField(body, 'autonomy') === undefined
            ? 'managed'
            : (readOptionalTrimmedStringField(body, 'autonomy') as never),
        capabilities:
          readOptionalRecordField(body, 'capabilities') === undefined
            ? {}
            : (readOptionalRecordField(body, 'capabilities') as never),
        idempotencyPrefix: requireTrimmedStringField(body, 'idempotencyPrefix'),
      }),
    { save: true }
  )
  return json({ context })
}

export const handleAttachWorkflowEvidence: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const actorRef = actorRefFromUnknown(body['actor'], actor?.agentId)
  const evidenceItems = readOptionalArrayField(body, 'evidence') as
    | Array<{ kind: string; ref: string; summary?: string }>
    | undefined
  if (evidenceItems === undefined || evidenceItems.length === 0) {
    unprocessable('invalid_evidence', 'At least one evidence item is required')
  }

  const idempotencyKey = requireTrimmedStringField(body, 'idempotencyKey')
  let isReplay = false

  const result = withDurableWorkflowKernel(
    deps,
    (kernel) => {
      const snapshot = kernel.exportSnapshot()
      const existingKey = snapshot.idempotency.find((entry) => entry.key === idempotencyKey)
      if (existingKey !== undefined) {
        isReplay = true
      }
      return kernel.attachEvidence({
        taskId,
        actor: actorRef,
        ...(readOptionalTrimmedStringField(body, 'role') !== undefined
          ? { role: readOptionalTrimmedStringField(body, 'role') }
          : {}),
        ...(readOptionalTrimmedStringField(body, 'runId') !== undefined
          ? { runId: readOptionalTrimmedStringField(body, 'runId') }
          : {}),
        ...(readOptionalTrimmedStringField(body, 'supervisorRunId') !== undefined
          ? { supervisorRunId: readOptionalTrimmedStringField(body, 'supervisorRunId') }
          : {}),
        ...(readOptionalTrimmedStringField(body, 'participantRunId') !== undefined
          ? { participantRunId: readOptionalTrimmedStringField(body, 'participantRunId') }
          : {}),
        evidence: evidenceItems,
        ...(body['expectedTaskVersion'] !== undefined
          ? { expectedTaskVersion: requireNumberField(body, 'expectedTaskVersion') }
          : {}),
        idempotencyKey,
      })
    },
    { save: true }
  )

  if (!result.ok) {
    if (result.error.code === 'authority_not_granted') {
      forbidden('evidence_attach_unauthorized', result.error.message)
    }
    if (result.error.code === 'idempotency_conflict') {
      conflict(result.error.message)
    }
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }

  await reconcileEffects(deps)
  return json({ evidence: result.evidence }, isReplay ? 200 : 201)
}
