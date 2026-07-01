import { AcpHttpError, json, unprocessable } from '../http.js'
import { reconcileWrkfEffects } from '../integration/wrkf-effect-reconciler.js'
import { extractActor } from '../parsers/actor.js'
import {
  isRecord,
  parseJsonBody,
  readOptionalArrayField,
  readOptionalTrimmedStringField,
  requireNumberField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { actorRefFromUnknown } from '../workflow-runtime.js'
import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
import { defaultWorkflowPackRegistry } from '../wrkf/packs/default-registry.js'
import { consumeVerifyLaunchIntents } from '../wrkf/verify-launch-consumer.js'

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
  if (
    deps.launchRoleScopedRun === undefined ||
    deps.launchCommandScopedRun === undefined ||
    deps.verifyCommandTargetId === undefined
  ) {
    return
  }
  void consumeVerifyLaunchIntents(
    {
      wrkf,
      runStore: deps.runStore,
      launchRoleScopedRun: deps.launchRoleScopedRun,
      launchCommandScopedRun: deps.launchCommandScopedRun,
      verifyCommandTargetId: deps.verifyCommandTargetId,
      ...(deps.triageCommandTargetId !== undefined
        ? { triageCommandTargetId: deps.triageCommandTargetId }
        : {}),
      ...(deps.implCommandTargetId !== undefined
        ? { implCommandTargetId: deps.implCommandTargetId }
        : {}),
      ...(deps.runtimeResolver !== undefined ? { runtimeResolver: deps.runtimeResolver } : {}),
      ...(deps.agentRootResolver !== undefined
        ? { agentRootResolver: deps.agentRootResolver }
        : {}),
      ...(deps.adminStore !== undefined ? { adminStore: deps.adminStore } : {}),
      ...(deps.verifyCommandSessionRef !== undefined
        ? { verifyCommandSessionRef: deps.verifyCommandSessionRef }
        : {}),
    },
    { taskId }
  ).catch((error) => {
    console.error('wrkf verify-launch effect tick failed', error)
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

    // Resolve the generic workflow pack for this task from its workflow ref +
    // template hash. Unknown workflows degrade to { level: 0, supported: false }.
    const workflowId = optionalString(inspectedRecord, 'templateId') ?? ''
    const version = String(optionalWorkflowVersion(inspectedRecord))
    const templateHash = optionalString(inspectedRecord, 'templateHash')
    const workflowRef = `${workflowId}@${version}`
    const { pack: resolvedPack, support } = defaultWorkflowPackRegistry.resolve({
      workflowRef,
      ...(templateHash !== undefined ? { templateHash } : {}),
    })
    const pack = {
      ...(resolvedPack?.id !== undefined ? { id: resolvedPack.id } : {}),
      level: support.level,
      supported: support.supported,
      ...(support.reason !== undefined ? { reason: support.reason } : {}),
    }

    return json({
      source: 'wrkf',
      task,
      instance,
      pack,
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
      principal_ref: wrkfActorFromBody(body['actor'], actor?.agentId),
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

export const handleAttachWorkflowEvidence: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const wrkfActor = wrkfActorFromBody(body['actor'], actor?.agentId)

  // Legacy compatibility: wrkf evidence.add has NO expectRevision/idempotencyKey/runId.
  // expectedTaskVersion is a phantom precondition here — never translate it to a wrkf param.
  // Explicitly ignore it with a compatibility warning rather than honoring it silently.
  if (body['expectedTaskVersion'] !== undefined) {
    console.warn(
      `[acp-server] evidence.add: ignoring legacy expectedTaskVersion (no such wrkf precondition) for task ${taskId}`
    )
  }

  const kind = requireTrimmedStringField(body, 'kind')
  const ref = readOptionalTrimmedStringField(body, 'ref')
  const summary = readOptionalTrimmedStringField(body, 'summary')
  const rawFacts = body['facts']
  if (rawFacts !== undefined && !isRecord(rawFacts)) {
    unprocessable('invalid_evidence', 'facts must be an object', { field: 'facts' })
  }
  const facts = rawFacts as Record<string, unknown> | undefined
  const role = readOptionalTrimmedStringField(body, 'role')
  const hasData = Object.prototype.hasOwnProperty.call(body, 'data')

  try {
    const result = await wrkf.evidence.add({
      task: taskId,
      kind,
      principal_ref: wrkfActor,
      ...(ref !== undefined ? { ref } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(facts !== undefined ? { facts } : {}),
      ...(hasData ? { data: body['data'] } : {}),
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

export const handleSatisfyWorkflowObligation: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const obligationId = requireObligationId(params)
  const wrkf = deps.wrkf
  if (wrkf === undefined) {
    throw new AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
  }
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body, { required: false })
  const wrkfActor =
    body['actor'] !== undefined || actor !== undefined
      ? wrkfActorFromBody(body['actor'], actor?.agentId)
      : undefined
  const evidenceId = readOptionalTrimmedStringField(body, 'evidenceId')
  const role = readOptionalTrimmedStringField(body, 'role')
  const reason = readOptionalTrimmedStringField(body, 'reason')

  // Do NOT pre-check existence via an ACP obligation list — wrkf is authoritative.
  try {
    const result = await wrkf.obligation.satisfy({
      task: taskId,
      id: obligationId,
      ...(evidenceId !== undefined ? { evidenceId } : {}),
      ...(wrkfActor !== undefined ? { principal_ref: wrkfActor } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(reason !== undefined ? { reason } : {}),
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
