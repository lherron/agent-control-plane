import { json, notFound } from '../http.js'
import { requireRunId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetRun: RouteHandler = ({ params, deps }) => {
  const runId = requireRunId(params)
  const run = deps.runStore.getRun(runId)
  if (run === undefined) {
    notFound(`run not found: ${runId}`, { runId })
  }

  const queue = deps.inputQueueStore.getByRunId(runId)

  return json({
    run,
    ...(queue !== undefined
      ? {
          queue: {
            queueItemId: queue.queueItemId,
            status: queue.status,
            seq: queue.seq,
            resetPolicy: queue.resetPolicy,
          },
        }
      : {}),
  })
}
