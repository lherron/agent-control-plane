import type { DashboardEvent } from 'acp-ops-projection'
import { parseNdjsonChunk } from 'acp-ops-reducer'

export type StreamConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'replaying'
  | 'paused'
  | 'degraded'
  | 'disconnected'

export type StreamRequest = {
  fromSeq: number
  follow?: boolean | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
  runId?: string | undefined
  family?: string | undefined
}

export type StreamHandlers = {
  onEvent?: ((event: DashboardEvent) => void) | undefined
  onStateChange?: ((state: StreamConnectionState) => void) | undefined
  onError?: ((error: Error) => void) | undefined
  onDroppedLines?: ((count: number) => void) | undefined
  onReconnect?: ((fromSeq: number) => void) | undefined
  onGap?: ((requestedFromSeq: number) => void) | undefined
  getLastProcessedHrcSeq?: (() => number) | undefined
}

export type StreamSubscription = {
  close: () => void
}

const RECONNECT_DELAY_MS = 350

function streamUrl(request: StreamRequest, fromSeq: number): string {
  const params = new URLSearchParams()
  params.set('fromSeq', String(fromSeq))
  params.set('follow', String(request.follow ?? true))
  if (request.scopeRef !== undefined) params.set('scopeRef', request.scopeRef)
  if (request.laneRef !== undefined) params.set('laneRef', request.laneRef)
  if (request.hostSessionId !== undefined) params.set('hostSessionId', request.hostSessionId)
  if (request.runId !== undefined) params.set('runId', request.runId)
  if (request.family !== undefined && request.family !== 'all') params.set('family', request.family)
  return `/v1/ops/session-dashboard/events?${params.toString()}`
}

export function openSessionDashboardStream(
  request: StreamRequest,
  handlers: StreamHandlers = {}
): StreamSubscription {
  let closed = false
  let reconnectTimer: number | undefined
  let abortController: AbortController | null = null
  let lastProcessedHrcSeq = Math.max(0, request.fromSeq - 1)
  const seenEventIds = new Set<string>()

  const currentCursor = () =>
    Math.max(lastProcessedHrcSeq, handlers.getLastProcessedHrcSeq?.() ?? 0)

  const scheduleReconnect = (state: StreamConnectionState = 'reconnecting') => {
    if (closed) return
    handlers.onStateChange?.(state)
    const fromSeq = currentCursor() + 1
    handlers.onReconnect?.(fromSeq)
    reconnectTimer = window.setTimeout(() => {
      void run(fromSeq)
    }, RECONNECT_DELAY_MS)
  }

  const run = async (fromSeq: number): Promise<void> => {
    if (closed) return
    abortController?.abort()
    abortController = new AbortController()
    let remainder = ''

    try {
      const response = await fetch(streamUrl(request, fromSeq), {
        signal: abortController.signal,
        headers: { Accept: 'application/x-ndjson' },
      })

      if (
        response.status === 404 ||
        response.status === 409 ||
        response.status === 410 ||
        response.status === 416
      ) {
        handlers.onGap?.(fromSeq)
        scheduleReconnect('degraded')
        return
      }

      if (!response.ok) {
        handlers.onError?.(
          new Error(`Stream fetch failed: ${response.status} ${response.statusText}`)
        )
        scheduleReconnect('degraded')
        return
      }

      handlers.onStateChange?.(fromSeq > request.fromSeq ? 'replaying' : 'connected')
      if (!response.body) {
        scheduleReconnect()
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        const parsed = parseNdjsonChunk(remainder + decoder.decode(value, { stream: true }))
        remainder = parsed.remainder
        if (parsed.droppedLines > 0) handlers.onDroppedLines?.(parsed.droppedLines)

        for (const event of parsed.events) {
          lastProcessedHrcSeq = Math.max(lastProcessedHrcSeq, event.hrcSeq)
          if (seenEventIds.has(event.id)) continue
          seenEventIds.add(event.id)
          handlers.onEvent?.(event)
        }
      }

      const tail = decoder.decode()
      if (tail.length > 0 || remainder.length > 0) {
        const parsed = parseNdjsonChunk(`${remainder}${tail}\n`)
        if (parsed.droppedLines > 0) handlers.onDroppedLines?.(parsed.droppedLines)
        for (const event of parsed.events) {
          lastProcessedHrcSeq = Math.max(lastProcessedHrcSeq, event.hrcSeq)
          if (seenEventIds.has(event.id)) continue
          seenEventIds.add(event.id)
          handlers.onEvent?.(event)
        }
      }

      scheduleReconnect('replaying')
    } catch (err) {
      if (closed || (err instanceof Error && err.name === 'AbortError')) return
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      scheduleReconnect('degraded')
    }
  }

  void run(Math.max(0, request.fromSeq))

  return {
    close() {
      closed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      abortController?.abort()
      abortController = null
      handlers.onStateChange?.('disconnected')
    },
  }
}
