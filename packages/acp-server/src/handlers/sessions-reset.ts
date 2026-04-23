import { badRequest, json } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseSessionRefField } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

function toHrcSessionRef(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneRef}`
}

export const handleResetSession: RouteHandler = async ({ request, deps }) => {
  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')

  const resolved = await hrcClient.resolveSession({
    sessionRef: toHrcSessionRef(sessionRef.scopeRef, sessionRef.laneRef),
  })

  const cleared = await hrcClient.clearContext({
    hostSessionId: resolved.hostSessionId,
  })

  return json({
    sessionId: cleared.hostSessionId,
    generation: cleared.generation,
    priorSessionId: cleared.priorHostSessionId,
  })
}
