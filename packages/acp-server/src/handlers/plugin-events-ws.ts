import { type HrcBoundedEventStreamRecord, HrcDomainError } from 'hrc-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { encodePluginEventCursor } from './plugin-event-cursor.js'
import {
  type AcpPluginEventFilters,
  PluginEventRequestError,
  assertOnlySearchParams,
  parsePluginEventFilters,
  pluginEventMatchesFilters,
  resolvePluginEventCursor,
  toHrcEventFilters,
} from './plugin-events.js'

const PLUGIN_EVENTS_WS_PATH = '/v1/plugins/events'
const PLUGIN_EVENTS_WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const PLUGIN_EVENTS_WS_ALLOWED_QUERY = new Set([
  'after',
  'sourceRef',
  'hostSessionId',
  'generation',
  'scopeRef',
  'laneRef',
  'runtimeId',
  'runId',
  'category',
  'eventKind',
])

export type PluginEventsWebSocketData = {
  kind: 'plugin-events'
  deps: ResolvedAcpServerDeps
  url: string
  abortController: AbortController
}

export type PluginEventsWebSocketLike = {
  data: PluginEventsWebSocketData
  readonly bufferedAmount: number
  send(message: string): number
  close(code?: number, reason?: string): void
}

export function isPluginEventsWebSocketPath(pathname: string): boolean {
  return pathname === PLUGIN_EVENTS_WS_PATH
}

export function buildPluginEventsUpgradeData(
  deps: ResolvedAcpServerDeps,
  url: string
): PluginEventsWebSocketData {
  return {
    kind: 'plugin-events',
    deps,
    url,
    abortController: new AbortController(),
  }
}

export function isPluginEventsWebSocketData(value: unknown): value is PluginEventsWebSocketData {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'plugin-events'
  )
}

function abortAndClose(ws: PluginEventsWebSocketLike, code: number, reason: string): void {
  ws.data.abortController.abort()
  ws.close(code, reason)
}

function sendWireRecord(ws: PluginEventsWebSocketLike, record: unknown): boolean {
  const serialized = JSON.stringify(record)
  const recordBytes = Buffer.byteLength(serialized, 'utf8')
  if (ws.bufferedAmount + recordBytes > PLUGIN_EVENTS_WS_MAX_BUFFERED_BYTES) {
    abortAndClose(ws, 1013, 'slow_consumer')
    return false
  }
  try {
    if (ws.send(serialized) <= 0) {
      abortAndClose(ws, 1013, 'slow_consumer')
      return false
    }
    return true
  } catch {
    ws.data.abortController.abort()
    return false
  }
}

function sendErrorAndClose(
  ws: PluginEventsWebSocketLike,
  code: string,
  message: string,
  closeCode = 1008
): void {
  sendWireRecord(ws, { type: 'error', code, message })
  if (!ws.data.abortController.signal.aborted) abortAndClose(ws, closeCode, code)
}

function assertRecordIncarnation(
  record: Exclude<HrcBoundedEventStreamRecord, { type: 'ledger_replaced' }>,
  expectedLedgerIncarnationId: string
): void {
  if (record.ledgerIncarnationId !== expectedLedgerIncarnationId) {
    throw new PluginEventRequestError(
      'cursor_invalid',
      'event ledger incarnation changed during streaming',
      409
    )
  }
}

function mapRecord(
  record: Exclude<HrcBoundedEventStreamRecord, { type: 'ledger_replaced' }>,
  filters: AcpPluginEventFilters,
  expectedLedgerIncarnationId: string,
  expectedAfterHrcSeq: number
): unknown {
  assertRecordIncarnation(record, expectedLedgerIncarnationId)
  if (record.type === 'ready') {
    if (record.acceptedAfterHrcSeq !== expectedAfterHrcSeq) {
      throw new PluginEventRequestError(
        'cursor_invalid',
        'HRC admitted a different event-stream start position',
        409
      )
    }
    return {
      type: 'ready',
      ledgerIncarnationId: record.ledgerIncarnationId,
      acceptedAfterHrcSeq: record.acceptedAfterHrcSeq,
      replayHeadHrcSeq: record.replayHeadHrcSeq,
    }
  }
  if (record.type === 'event') {
    if (!pluginEventMatchesFilters(record.event, filters)) {
      throw new PluginEventRequestError(
        'filter_assertion_failed',
        'HRC returned an event that violates the requested exact filters',
        500
      )
    }
    return {
      type: 'event',
      cursor: encodePluginEventCursor({
        ledgerIncarnationId: record.ledgerIncarnationId,
        hrcSeq: record.event.hrcSeq,
      }),
      event: record.event,
    }
  }
  const after = encodePluginEventCursor({
    ledgerIncarnationId: record.ledgerIncarnationId,
    hrcSeq: record.afterHrcSeq,
  })
  const before = encodePluginEventCursor({
    ledgerIncarnationId: record.ledgerIncarnationId,
    hrcSeq: record.beforeHrcSeq,
  })
  return {
    type: 'gap',
    cursor: before,
    reason: record.reason,
    dropped: record.dropped,
    after,
    before,
  }
}

export async function openPluginEventsWebSocket(ws: PluginEventsWebSocketLike): Promise<void> {
  const { deps, url, abortController } = ws.data
  let iterator: AsyncIterator<HrcBoundedEventStreamRecord> | undefined
  try {
    if (deps.hrcClient === undefined) {
      throw new PluginEventRequestError('runtime_unavailable', 'hrcClient not configured', 503)
    }
    const parsedUrl = new URL(url)
    assertOnlySearchParams(parsedUrl, PLUGIN_EVENTS_WS_ALLOWED_QUERY)
    const after = parsedUrl.searchParams.get('after')
    if (after === null || after.length === 0) {
      throw new PluginEventRequestError(
        'malformed_request',
        'after cursor is required; use after=now to start at the current head'
      )
    }
    const filters = parsePluginEventFilters(parsedUrl)
    const resolved = await resolvePluginEventCursor(deps.hrcClient, after)
    iterator = deps.hrcClient
      .watchBoundedEvents({
        ledgerIncarnationId: resolved.ledgerIncarnationId,
        afterSeq: resolved.hrcSeq,
        ...toHrcEventFilters(filters),
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]()

    while (!abortController.signal.aborted) {
      const next = await iterator.next()
      if (next.done) {
        if (!abortController.signal.aborted) {
          sendErrorAndClose(
            ws,
            'plugin_event_stream_closed',
            'HRC event stream closed unexpectedly',
            1011
          )
        }
        return
      }
      const record = next.value
      if (record.type === 'ledger_replaced') {
        sendErrorAndClose(ws, 'cursor_invalid', 'event ledger incarnation is no longer current')
        return
      }
      const wireRecord = mapRecord(record, filters, resolved.ledgerIncarnationId, resolved.hrcSeq)
      if (!sendWireRecord(ws, wireRecord)) return
    }
  } catch (error) {
    if (abortController.signal.aborted) return
    if (error instanceof PluginEventRequestError) {
      sendErrorAndClose(ws, error.code, error.message, error.status >= 500 ? 1011 : 1008)
      return
    }
    if (error instanceof HrcDomainError && error.code === 'cursor_invalid') {
      sendErrorAndClose(ws, 'cursor_invalid', error.message)
      return
    }
    sendErrorAndClose(
      ws,
      'plugin_event_stream_failed',
      error instanceof Error ? error.message : String(error),
      1011
    )
  } finally {
    abortController.abort()
    if (iterator?.return !== undefined) {
      try {
        await iterator.return()
      } catch {
        // Stream cancellation is best effort after the socket has closed.
      }
    }
  }
}

export function handlePluginEventsWebSocketMessage(
  ws: PluginEventsWebSocketLike,
  message: string | Buffer
): void {
  const text = typeof message === 'string' ? message : message.toString('utf8')
  try {
    const parsed = JSON.parse(text) as { type?: unknown }
    if (parsed.type === 'ping') sendWireRecord(ws, { type: 'pong' })
  } catch {
    // Unknown or malformed client controls do not mutate stream state.
  }
}

export function closePluginEventsWebSocket(ws: PluginEventsWebSocketLike): void {
  ws.data.abortController.abort()
}
