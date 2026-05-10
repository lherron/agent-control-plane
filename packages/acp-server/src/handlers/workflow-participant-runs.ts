import { json, unprocessable } from '../http.js'
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
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
    },
    { save: true }
  )

  if (!result.ok) {
    unprocessable(result.error.code, result.error.message, { ...result.error })
  }
  return json(result, isReplay ? 200 : 201)
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
