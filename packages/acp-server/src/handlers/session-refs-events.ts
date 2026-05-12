import { parseSessionRef } from 'agent-scope'

import { badRequest } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson',
  'transfer-encoding': 'chunked',
}

const SESSION_REFS_EVENTS_KEEPALIVE_MS = 5_000

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

function laneIdFromRef(laneRef: string): string {
  return laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
}

function parseRequiredSessionRef(raw: string | null): { scopeRef: string; laneRef: string } {
  if (raw === null || raw.trim().length === 0) {
    badRequest('sessionRef is required', { field: 'sessionRef' })
  }

  try {
    const parsed = parseSessionRef(raw)
    return {
      scopeRef: parsed.scopeRef,
      laneRef: laneIdFromRef(parsed.laneRef),
    }
  } catch (error) {
    badRequest('sessionRef must use "<scopeRef>/lane:<laneRef>" format', {
      field: 'sessionRef',
      value: raw,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export const handleSessionRefEvents: RouteHandler = async ({ request, url, deps }) => {
  const hrcClient = deps.hrcClient
  if (hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }

  const sessionRef = parseRequiredSessionRef(url.searchParams.get('sessionRef'))
  const fromSeq = parseOptionalPositiveInteger(url.searchParams.get('fromSeq'), 'fromSeq')
  const follow = parseFollow(url.searchParams.get('follow'))
  const generation = parseOptionalNonNegativeInteger(
    url.searchParams.get('generation'),
    'generation'
  )
  const runId = readOptionalQuery(url.searchParams.get('runId'))

  const abortController = new AbortController()
  const iterable = hrcClient.watch({
    scopeRef: sessionRef.scopeRef,
    laneRef: sessionRef.laneRef,
    ...(fromSeq !== undefined ? { fromSeq } : {}),
    follow,
    ...(runId !== undefined ? { runId } : {}),
    ...(generation !== undefined ? { generation } : {}),
    signal: abortController.signal,
  })
  const iterator = iterable[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  let keepalive: ReturnType<typeof setInterval> | undefined
  let closed = false

  const close = (closeStream = true) => {
    if (closed) {
      return
    }

    closed = true
    abortController.abort()
    if (keepalive !== undefined) {
      clearInterval(keepalive)
      keepalive = undefined
    }

    void iterator.return?.()
    if (closeStream) {
      try {
        controllerRef?.close()
      } catch {
        // Bun may close the stream first when the client disconnects.
      }
    }
  }

  request.signal.addEventListener('abort', () => close(), { once: true })

  const readableStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      if (follow) {
        keepalive = setInterval(() => {
          if (closed) {
            return
          }

          try {
            controller.enqueue(encoder.encode('\n'))
          } catch {
            close()
          }
        }, SESSION_REFS_EVENTS_KEEPALIVE_MS)
      }
    },
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
          close(false)
          controller.close()
          return
        }

        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
      } catch (error) {
        if (!closed) {
          close(false)
          controller.error(error)
        }
      }
    },
    cancel: () => close(),
  })

  return new Response(readableStream, {
    status: 200,
    headers: {
      ...NDJSON_HEADERS,
      'x-acp-session-ref': `${sessionRef.scopeRef}/lane:${sessionRef.laneRef}`,
    },
  })
}
