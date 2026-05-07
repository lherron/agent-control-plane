import { badRequest, json } from '../http.js'
import { recordInputAdmissionEvent } from '../input-admission/input-admission-events.js'
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
    if (item.status === 'queued' || item.status === 'leased' || item.status === 'dispatching') {
      const expiredItem = deps.inputQueueStore.update(item.queueItemId, { status: 'expired' })
      const expiredRun = deps.runStore.updateRun(item.runId, {
        status: 'cancelled',
        errorCode: 'reset_expired',
        errorMessage: 'queued input expired because session context was reset',
      })
      const expiredAdmission = deps.inputAdmissionStore.update(item.inputAttemptId, {
        status: 'expired',
        currentState: { queueStatus: 'expired', reason: 'reset_policy', seq: item.seq },
      })
      recordInputAdmissionEvent(deps, {
        eventKind: 'input.queue.expired',
        scopeRef: item.scopeRef,
        laneRef: item.laneRef,
        inputAttemptId: item.inputAttemptId,
        admission: expiredAdmission,
        run: expiredRun,
        queueItem: expiredItem,
        reason: 'reset_policy',
      })
    }
  }

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
