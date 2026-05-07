import { json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetInputAttempt: RouteHandler = ({ params, deps }) => {
  const inputAttemptId = params['inputAttemptId']
  if (inputAttemptId === undefined || inputAttemptId.trim().length === 0) {
    notFound('input attempt not found')
  }

  const attempt = deps.inputAttemptStore.getById(inputAttemptId)
  if (attempt === undefined) {
    notFound(`input attempt not found: ${inputAttemptId}`, { inputAttemptId })
  }

  const admission = deps.inputAdmissionStore.getByInputAttemptId(inputAttemptId)
  const currentState =
    admission?.runId === undefined
      ? admission?.currentState
      : {
          ...(admission.currentState ?? {}),
          runStatus: deps.runStore.getRun(admission.runId)?.status,
          queueStatus: deps.inputQueueStore.getByRunId(admission.runId)?.status,
        }

  return json({
    inputAttempt: attempt.inputAttempt,
    ...(attempt.runId !== undefined ? { runId: attempt.runId } : {}),
    ...(admission !== undefined ? { admission: admission.originalResponse } : {}),
    ...(currentState !== undefined ? { currentState } : {}),
  })
}
