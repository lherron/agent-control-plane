import { badRequest, json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleListSessionRuns: RouteHandler = ({ params, deps }) => {
  const sessionId = params['sessionId']
  if (sessionId === undefined || sessionId.length === 0) {
    badRequest('sessionId route param is required', { field: 'sessionId' })
  }

  const runs = deps.runStore.listRuns().filter((run) => run.hostSessionId === sessionId)

  return json({ runs })
}
