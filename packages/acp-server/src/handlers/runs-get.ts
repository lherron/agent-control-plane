import { json, notFound } from '../http.js'
import { requireRunId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetRun: RouteHandler = ({ params, deps }) => {
  const runId = requireRunId(params)
  const run = deps.runStore.getRun(runId)
  if (run === undefined) {
    notFound(`run not found: ${runId}`, { runId })
  }

  return json({ run })
}
