import { HrcDomainError, HrcErrorCode } from 'hrc-core'

import { badRequest, json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleGetSession: RouteHandler = async ({ params, deps }) => {
  const sessionId = params['sessionId']
  if (sessionId === undefined || sessionId.length === 0) {
    badRequest('sessionId route param is required', { field: 'sessionId' })
  }

  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  try {
    const record = await hrcClient.getSession(sessionId)
    return json({
      session: {
        sessionId: record.hostSessionId,
        scopeRef: record.scopeRef,
        laneRef: record.laneRef,
        generation: record.generation,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    })
  } catch (error) {
    if (error instanceof HrcDomainError && error.code === HrcErrorCode.UNKNOWN_HOST_SESSION) {
      notFound(`session not found: ${sessionId}`, { sessionId })
    }

    throw error
  }
}
