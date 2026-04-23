import { json, notFound } from '../http.js'
import { requireRunId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export const handleCancelRun: RouteHandler = async ({ params, deps }) => {
  const runId = requireRunId(params)
  const run = deps.runStore.getRun(runId)
  if (run === undefined) {
    notFound(`run not found: ${runId}`, { runId })
  }

  if (TERMINAL_STATUSES.has(run.status)) {
    return json({ run })
  }

  const updated = deps.runStore.updateRun(runId, {
    status: 'cancelled',
    errorCode: 'cancelled',
  })

  if (run.runtimeId !== undefined && deps.hrcClient !== undefined) {
    await deps.hrcClient.interrupt(run.runtimeId)
  }

  return json({ run: updated })
}
