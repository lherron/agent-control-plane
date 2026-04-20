import { json, notFound } from '../http.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseSessionRefField } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleResolveSession: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const sessionId = deps.sessionResolver ? await deps.sessionResolver(sessionRef) : undefined

  if (sessionId === undefined) {
    notFound(`session not found for ${sessionRef.scopeRef}`, {
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
    })
  }

  return json({ sessionId })
}
