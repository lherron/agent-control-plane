import { normalizeSessionRef } from 'agent-scope'
import { json, unprocessable } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  parseJsonBody,
  readOptionalArrayField,
  readOptionalRecordField,
  readOptionalTrimmedStringField,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'
import { actorRefFromUnknown, withDurableWorkflowKernel } from '../workflow-runtime.js'

export const handleCreateWorkflowParticipantRun: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const taskId = requireTrimmedStringField(body, 'taskId')
  const role = requireTrimmedStringField(body, 'role')
  const actor = actorRefFromUnknown(body['actor'])
  const harness = readOptionalRecordField(body, 'harness')
  const idempotencyKey = readOptionalTrimmedStringField(body, 'idempotencyKey')
  const resume = body['resume'] === true
  const hrcRunId = readOptionalTrimmedStringField(body, 'hrcRunId')
  const runtimeId = readOptionalTrimmedStringField(body, 'runtimeId')
  const launchId = readOptionalTrimmedStringField(body, 'launchId')
  const hostSessionId = readOptionalTrimmedStringField(body, 'hostSessionId')
  const scopeRef = readOptionalTrimmedStringField(body, 'scopeRef')
  const laneRef = readOptionalTrimmedStringField(body, 'laneRef')
  const generation = typeof body['generation'] === 'number' ? body['generation'] : undefined
  const launchRuntime = body['launchRuntime'] === true

  if (resume) {
    const result = withDurableWorkflowKernel(
      deps,
      (kernel) => kernel.resumeParticipantRun({ taskId, role, actor }),
      { save: true }
    )
    if (!result.ok) {
      unprocessable(result.error.code, result.error.message, { ...result.error })
    }
    return json(result, 200)
  }

  let isReplay = false
  const launchIdempotencyKey = idempotencyKey
  const result = withDurableWorkflowKernel(
    deps,
    (kernel) => {
      if (idempotencyKey) {
        const snapshot = kernel.exportSnapshot()
        const existingKey = snapshot.idempotency.find((entry) => entry.key === idempotencyKey)
        if (existingKey !== undefined) {
          isReplay = true
        }
      }
      return kernel.startParticipantRun({
        taskId,
        role,
        actor,
        ...(harness !== undefined ? { harness } : {}),
        ...(hrcRunId !== undefined
          ? {
              hrc: {
                hrcRunId,
                ...(runtimeId !== undefined ? { runtimeId } : {}),
                ...(launchId !== undefined ? { launchId } : {}),
                ...(hostSessionId !== undefined ? { hostSessionId } : {}),
                ...(scopeRef !== undefined ? { scopeRef } : {}),
                ...(laneRef !== undefined ? { laneRef } : {}),
                ...(generation !== undefined ? { generation } : {}),
                source: 'launch',
              },
            }
          : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
    },
    { save: true }
  )

  if (!result.ok) {
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }
  if (launchRuntime && !isReplay) {
    if (deps.launchRoleScopedRun === undefined) {
      unprocessable('runtime_launcher_unavailable', 'No HRC runtime launcher is configured')
    }
    if (scopeRef === undefined) {
      unprocessable('scope_ref_required', '--scope-ref is required when launchRuntime is true')
    }

    const sessionRef = normalizeSessionRef({ scopeRef, laneRef: laneRef ?? 'main' })
    const intent = await resolveLaunchIntent(deps, sessionRef, {
      initialPrompt: buildWorkflowParticipantPrompt(result.context),
    })
    const launched = await deps.launchRoleScopedRun({
      sessionRef,
      intent,
      waitForCompletion: false,
    })
    const mapped = withDurableWorkflowKernel(
      deps,
      (kernel) =>
        kernel.recordWorkflowHrcRunMap({
          workflowTaskId: taskId,
          participantRunId: result.participantRun.runId,
          hrcRunId: launched.runId,
          ...(launched.runtimeId !== undefined ? { runtimeId: launched.runtimeId } : {}),
          ...(launched.launchId !== undefined ? { launchId: launched.launchId } : {}),
          ...(launched.hostSessionId !== undefined
            ? { hostSessionId: launched.hostSessionId }
            : {}),
          scopeRef,
          laneRef: laneRef ?? 'main',
          ...(launched.generation !== undefined ? { generation: launched.generation } : {}),
          source: 'launch',
          actor,
          ...(launchIdempotencyKey !== undefined
            ? { idempotencyKey: `${launchIdempotencyKey}:hrc-map` }
            : {}),
        }),
      { save: true }
    )
    if (!mapped.ok) {
      unprocessable(mapped.error.code, mapped.error.message, { ...mapped.error })
    }
    return json(
      {
        ...result,
        launch: launched,
        workflowHrcRunMap: mapped.map,
      },
      201
    )
  }
  return json(result, isReplay ? 200 : 201)
}

function buildWorkflowParticipantPrompt(context: Record<string, unknown>): string {
  return [
    'You are starting an ACP workflow participant run.',
    'Use the context below as the authoritative task contract and continue autonomously within your role.',
    '',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
  ].join('\n')
}

export const handleCompleteWorkflowParticipantRun: RouteHandler = async ({
  request,
  params,
  deps,
}) => {
  const runId = params['runId']
  if (runId === undefined || runId.length === 0) {
    throw new Error('runId route parameter is required')
  }
  const body = requireRecord(await parseJsonBody(request))
  const outcome = requireTrimmedStringField(body, 'outcome')
  const evidenceRefs = readOptionalArrayField(body, 'evidenceRefs') as string[] | undefined
  const summary = readOptionalTrimmedStringField(body, 'summary')
  const idempotencyKey = readOptionalTrimmedStringField(body, 'idempotencyKey')

  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.completeParticipantRun(runId, {
        outcome,
        ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }),
    { save: true }
  )

  if (!result.ok) {
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }
  return json(result, 200)
}

export const handleFailWorkflowParticipantRun: RouteHandler = async ({ request, params, deps }) => {
  const runId = params['runId']
  if (runId === undefined || runId.length === 0) {
    throw new Error('runId route parameter is required')
  }
  const body = requireRecord(await parseJsonBody(request))
  const reason = requireTrimmedStringField(body, 'reason')
  const classification = readOptionalTrimmedStringField(body, 'classification')
  const idempotencyKey = readOptionalTrimmedStringField(body, 'idempotencyKey')

  const result = withDurableWorkflowKernel(
    deps,
    (kernel) =>
      kernel.failParticipantRun(runId, {
        reason,
        ...(classification !== undefined ? { classification } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      }),
    { save: true }
  )

  if (!result.ok) {
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }
  return json(result, 200)
}
