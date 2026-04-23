import { badRequest, json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleCaptureSession: RouteHandler = async ({ params, deps }) => {
  const sessionId = params['sessionId']
  if (sessionId === undefined || sessionId.length === 0) {
    badRequest('sessionId route param is required', { field: 'sessionId' })
  }

  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const runtimes = await hrcClient.listRuntimes({ hostSessionId: sessionId })
  if (runtimes.length === 0) {
    notFound(`no runtime found for session: ${sessionId}`, { sessionId })
  }

  const latest = runtimes.at(-1)
  if (latest === undefined) {
    notFound(`no runtime found for session: ${sessionId}`, { sessionId })
  }
  const result = await hrcClient.capture(latest.runtimeId)

  return json({ text: result.text })
}
