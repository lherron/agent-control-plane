import { randomUUID } from 'node:crypto'

import { AcpHttpError, json, unprocessable } from '../http.js'
import { reconcileWorkflowEffectIntents } from '../integration/workflow-effect-reconciler.js'
import { reconcileWrkfEffects } from '../integration/wrkf-effect-reconciler.js'
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
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'

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

function requireObligationId(params: Record<string, string | undefined>): string {
  const obligationId = params['obligationId']
  if (obligationId === undefined || obligationId.length === 0) {
    throw new Error('obligationId route parameter is required')
  }
  return obligationId
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

function enqueueWrkfEffectDeliveryTick(
  taskId: string,
  deps: Parameters<RouteHandler>[0]['deps']
): void {
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    return
  }
  void reconcileWrkfEffects({
    wrkf,
    coordStore: deps.coordStore,
    taskId,
  }).catch((error) => {
    console.error('wrkf effect delivery tick failed', error)
  })
}

function isWrkfError(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function optionalWorkflowVersion(record: Record<string, unknown>): number | string {
  const value = record['templateVersion']
  return typeof value === 'number' || typeof value === 'string' ? value : 0
}

function wrkfActorFromBody(value: unknown, fallbackAgentId?: string | undefined): string {
  const actor = actorRefFromUnknown(value, fallbackAgentId)
  return actor.kind === 'agent' ? `agent:${actor.id}` : `${actor.kind}:${actor.id}`
}

function projectFlatWrkfInspect(
  taskId: string,
  inspected: Record<string, unknown>
): Record<string, unknown> {
  return {
    taskId,
    projectId: optionalString(inspected, 'projectId') ?? '',
    workflow: {
      id: optionalString(inspected, 'templateId') ?? '',
      version: optionalWorkflowVersion(inspected),
      hash: optionalString(inspected, 'templateHash') ?? '',
    },
    state: {
      status: optionalString(inspected, 'status') ?? 'unknown',
      phase: optionalString(inspected, 'phase'),
    },
    version: optionalNumber(inspected, 'revision') ?? 0,
    goal: '',
    roleBindings: {},
    createdAt: optionalString(inspected, 'createdAt') ?? '',
    updatedAt: optionalString(inspected, 'updatedAt') ?? '',
  }
}

export const handleGetWorkflowTask: RouteHandler = async ({ params, deps }) => {
  const taskId = requireTaskId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  let inspectSucceeded = false
  try {
    const inspected = await wrkf.task.inspect({ task: taskId })
    inspectSucceeded = true
    const timeline = await wrkf.task.timeline({ task: taskId })
    const next = await wrkf.next({ task: taskId })
    const evidence = await wrkf.evidence.list({ task: taskId })
    const obligations = await wrkf.obligation.list({ task: taskId })
    const effects = await wrkf.effect.list({ task: taskId })
    const runs = await wrkf.run.list({ task: taskId })
    const inspectedRecord = isRecord(inspected) ? inspected : {}
    const nextRecord = isRecord(next) ? next : {}
    const task =
      inspectedRecord['task'] !== undefined
        ? inspectedRecord['task']
        : projectFlatWrkfInspect(taskId, inspectedRecord)
    const instance =
      inspectedRecord['instance'] !== undefined
        ? inspectedRecord['instance']
        : nextRecord['instance']
    return json({
      source: 'wrkf',
      task,
      instance,
      next,
      timeline,
      evidence,
      obligations,
      effects,
      runs,
    })
  } catch (error) {
    if (error instanceof AcpHttpError) {
      throw error
    }
    if (isWrkfError(error)) {
      throw new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
    }
    // task.inspect is the first wrkf call and resolves task identity. A non-WrkfError
    // thrown before it completes (e.g. SyntaxError from JSON.parse(undefined) when the
    // wrkf process returns no body for a task that has no wrkf instance) means the task
    // could not be resolved in wrkf. Map to WRKF_NOT_FOUND (404) instead of leaking a
    // raw SyntaxError/TypeError to the ACP global handler as a 500. Errors from later
    // calls (after inspect succeeded) still propagate, since the task identity is valid.
    if (!inspectSucceeded) {
      throw new AcpHttpError(404, 'WRKF_NOT_FOUND', `task not found in wrkf: ${taskId}`)
    }
    throw error
  }
}

export const handleApplyWorkflowTransition: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: true })

  // NOTE (W3): transition.apply does NOT accept evidenceRefs/waiverRefs/inlineEvidence/runId.
  // Evidence/obligation mutations are now separate wrkf calls performed before the transition.
  // The legacy expectedTaskVersion is the ONE field that aliases to a real wrkf precondition
  // (expectRevision); all other legacy CAS/evidence fields are intentionally dropped here.
  try {
    const result = await wrkf.transition.apply({
      task: taskId,
      transition: requireTrimmedStringField(body, 'transitionId'),
      role: requireTrimmedStringField(body, 'role'),
      actor: wrkfActorFromBody(body['actor'], actor?.agentId),
      ...(body['expectedTaskVersion'] !== undefined
        ? { expectRevision: requireNumberField(body, 'expectedTaskVersion') }
        : {}),
      ...(readOptionalTrimmedStringField(body, 'contextHash') !== undefined
        ? { contextHash: readOptionalTrimmedStringField(body, 'contextHash') }
        : {}),
      ...(readOptionalArrayField(body, 'checkIds') !== undefined
        ? { checkIds: readOptionalArrayField(body, 'checkIds') as string[] }
        : {}),
      ...(typeof body['runChecks'] === 'boolean' ? { runChecks: body['runChecks'] } : {}),
      ...(typeof body['dryRun'] === 'boolean' ? { dryRun: body['dryRun'] } : {}),
      idempotencyKey: requireTrimmedStringField(body, 'idempotencyKey'),
    })

    if (body['dryRun'] !== true) {
      enqueueWrkfEffectDeliveryTick(taskId, deps)
    }

    return json(result)
  } catch (error) {
    if (error instanceof AcpHttpError) {
      throw error
    }
    if (isWrkfError(error)) {
      throw new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
    }
    throw error
  }
}

export const handleWorkflowControlAction: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actorRaw = body['actor']
  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.submitControlAction({
        taskId,
        supervisorRunId: requireTrimmedStringField(body, 'supervisorRunId'),
        ...(actorRaw !== undefined && actorRaw !== null
          ? { actor: actorRefFromUnknown(actorRaw) }
          : {}),
        ...(readOptionalTrimmedStringField(body, 'contextHash') !== undefined
          ? { contextHash: readOptionalTrimmedStringField(body, 'contextHash') }
          : {}),
        ...(body['expectedTaskVersion'] !== undefined
          ? { expectedTaskVersion: requireNumberField(body, 'expectedTaskVersion') }
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
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const actorRef = actorRefFromUnknown(body['actor'], actor?.agentId)

  // Legacy compatibility: wrkf evidence.add has NO expectRevision/idempotencyKey/runId.
  // expectedTaskVersion is a phantom precondition here — never translate it to a wrkf param.
  // Explicitly ignore it with a compatibility warning rather than honoring it silently.
  if (body['expectedTaskVersion'] !== undefined) {
    console.warn(
      `[acp-server] evidence.add: ignoring legacy expectedTaskVersion (no such wrkf precondition) for task ${taskId}`
    )
  }

  const kind = requireTrimmedStringField(body, 'kind')
  const ref = requireTrimmedStringField(body, 'ref')
  const summary = readOptionalTrimmedStringField(body, 'summary')
  const facts = readOptionalRecordField(body, 'facts')
  const role = readOptionalTrimmedStringField(body, 'role')

  try {
    const result = await wrkf.evidence.add({
      task: taskId,
      kind,
      ref,
      actor: actorRef,
      ...(summary !== undefined ? { summary } : {}),
      ...(facts !== undefined ? { facts } : {}),
      ...(role !== undefined ? { role } : {}),
    })
    return json({ evidence: result }, 201)
  } catch (error) {
    if (error instanceof AcpHttpError) {
      throw error
    }
    if (isWrkfError(error)) {
      throw new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
    }
    throw error
  }
}

export const handleWaiveWorkflowObligation: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const obligationId = requireObligationId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))

  // Do NOT pre-check existence via an ACP obligation list — wrkf is authoritative for
  // obligation status and returns the canonical error if the obligation does not exist.
  try {
    const result = await wrkf.obligation.waive({
      task: taskId,
      id: obligationId,
      reason: requireTrimmedStringField(body, 'reason'),
    })
    return json(result)
  } catch (error) {
    if (error instanceof AcpHttpError) {
      throw error
    }
    if (isWrkfError(error)) {
      throw new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
    }
    throw error
  }
}

export const handleCancelWorkflowObligation: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const obligationId = requireObligationId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))

  const rawReason = body['reason']
  if (rawReason === undefined || typeof rawReason !== 'string' || rawReason.trim().length === 0) {
    unprocessable('invalid_evidence', 'reason is required to cancel an obligation')
  }
  const reason = (rawReason as string).trim()

  // Do NOT pre-check existence via an ACP obligation list — wrkf is authoritative.
  try {
    const result = await wrkf.obligation.cancel({
      task: taskId,
      id: obligationId,
      reason,
    })
    return json(result)
  } catch (error) {
    if (error instanceof AcpHttpError) {
      throw error
    }
    if (isWrkfError(error)) {
      throw new AcpHttpError(wrkfErrorToHttpStatus(error.code), error.code, error.message)
    }
    throw error
  }
}
