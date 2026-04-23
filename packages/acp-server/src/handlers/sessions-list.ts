import { badRequest, json } from '../http.js'

import type { AcpHrcClient } from '../deps.js'
import type { RouteHandler } from '../routing/route-context.js'

function projectSession(record: Awaited<ReturnType<AcpHrcClient['listSessions']>>[number]) {
  return {
    sessionId: record.hostSessionId,
    scopeRef: record.scopeRef,
    laneRef: record.laneRef,
    generation: record.generation,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export const handleListSessions: RouteHandler = async ({ url, deps }) => {
  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined

  const records = await hrcClient.listSessions({
    ...(scopeRef !== undefined ? { scopeRef } : {}),
    ...(laneRef !== undefined ? { laneRef } : {}),
  })

  return json({ sessions: records.map(projectSession) })
}
