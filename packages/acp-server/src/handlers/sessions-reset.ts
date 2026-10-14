import { badRequest, json } from '../http.js'
import { expireQueuedInput, isPendingQueueItem } from '../input-admission/expire-queued-input.js'
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

  for (const item of deps.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)) {
    if (item.resetPolicy === 'follow_latest') {
      continue
    }
    if (isPendingQueueItem(item)) {
      expireQueuedInput(deps, item, 'queued input expired because session context was reset')
    }
  }

  const resolved = await hrcClient.resolveSession({
    sessionRef: toHrcSessionRef(sessionRef.scopeRef, sessionRef.laneRef),
  })
  if (!resolved.found) {
    badRequest(`session not found for ${sessionRef.scopeRef}`)
  }

  const cleared = await hrcClient.clearContext({
    hostSessionId: resolved.hostSessionId,
  })

  return json({
    sessionId: cleared.hostSessionId,
    generation: cleared.generation,
    priorSessionId: cleared.priorHostSessionId,
  })
}
