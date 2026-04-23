import { badRequest } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleSessionEvents: RouteHandler = async ({ params, url, deps }) => {
  const sessionId = params['sessionId']
  if (sessionId === undefined || sessionId.length === 0) {
    badRequest('sessionId route param is required', { field: 'sessionId' })
  }

  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const fromSeqRaw = url.searchParams.get('fromSeq')
  const fromSeq = fromSeqRaw !== null ? Number.parseInt(fromSeqRaw, 10) : undefined

  const stream = hrcClient.watch({
    ...(fromSeq !== undefined && Number.isFinite(fromSeq) ? { fromSeq } : {}),
  })

  const encoder = new TextEncoder()
  const readableStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.hostSessionId !== sessionId) {
            continue
          }

          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(readableStream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson',
      'transfer-encoding': 'chunked',
    },
  })
}
