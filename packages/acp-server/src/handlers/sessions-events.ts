import { badRequest } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson',
  'transfer-encoding': 'chunked',
}

function parseOptionalPositiveInteger(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim().length === 0) {
    return undefined
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    badRequest(`${field} must be >= 1`, { field })
  }

  return parsed
}

function parseOptionalNonNegativeInteger(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim().length === 0) {
    return undefined
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    badRequest(`${field} must be a non-negative integer`, { field })
  }

  return parsed
}

function parseFollow(raw: string | null): boolean {
  if (raw === null || raw.trim().length === 0) {
    return true
  }

  if (raw === 'true') {
    return true
  }

  if (raw === 'false') {
    return false
  }

  badRequest('follow must be true or false', { field: 'follow' })
}

function readOptionalQuery(raw: string | null): string | undefined {
  const normalized = raw?.trim()
  return normalized === undefined || normalized.length === 0 ? undefined : normalized
}

export const handleSessionEvents: RouteHandler = async ({ request, params, url, deps }) => {
  const sessionId = params['sessionId']
  if (sessionId === undefined || sessionId.length === 0) {
    badRequest('sessionId route param is required', { field: 'sessionId' })
  }

  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const fromSeq = parseOptionalPositiveInteger(url.searchParams.get('fromSeq'), 'fromSeq')
  const follow = parseFollow(url.searchParams.get('follow'))
  const generation = parseOptionalNonNegativeInteger(
    url.searchParams.get('generation'),
    'generation'
  )
  const runId = readOptionalQuery(url.searchParams.get('runId'))

  const abortController = new AbortController()
  const iterable = hrcClient.watch({
    ...(fromSeq !== undefined ? { fromSeq } : {}),
    follow,
    hostSessionId: sessionId,
    ...(runId !== undefined ? { runId } : {}),
    ...(generation !== undefined ? { generation } : {}),
    signal: abortController.signal,
  })
  const iterator = iterable[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let closed = false

  const close = () => {
    if (closed) {
      return
    }

    closed = true
    abortController.abort()
    void iterator.return?.()
  }

  request.signal.addEventListener('abort', close, { once: true })

  const readableStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        return
      }

      try {
        const next = await iterator.next()
        if (closed) {
          return
        }

        if (next.done === true) {
          close()
          controller.close()
          return
        }

        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
      } catch (error) {
        if (!closed) {
          close()
          controller.error(error)
        }
      }
    },
    cancel: close,
  })

  return new Response(readableStream, {
    status: 200,
    headers: NDJSON_HEADERS,
  })
}
