import { describe, expect, test } from 'bun:test'

import {
  type HrcBoundedEventStreamRecord,
  HrcDomainError,
  type HrcEventTail,
  type HrcLifecycleEvent,
} from 'hrc-core'
import type { WatchBoundedEventsOptions } from 'hrc-sdk'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import {
  decodePluginEventCursor,
  encodePluginEventCursor,
} from '../src/handlers/plugin-event-cursor.js'
import {
  type PluginEventsWebSocketData,
  type PluginEventsWebSocketLike,
  buildPluginEventsUpgradeData,
  closePluginEventsWebSocket,
  handlePluginEventsWebSocketMessage,
  isPluginEventsWebSocketPath,
  openPluginEventsWebSocket,
} from '../src/handlers/plugin-events-ws.js'

const EVENT: HrcLifecycleEvent = {
  hrcSeq: 11,
  streamSeq: 22,
  sourceRef: 'node:peer',
  originSeq: 8,
  ts: '2026-08-23T18:00:00.000Z',
  hostSessionId: 'hsid-1',
  scopeRef: 'agent:cody:project:agent-control-plane',
  laneRef: 'primary',
  generation: 2,
  runtimeId: 'runtime-1',
  runId: 'run-1',
  category: 'turn',
  eventKind: 'turn.future',
  replayed: false,
  payload: { deep: { values: [1, 2, 3] } },
}

const AUTHORITY: HrcEventTail = {
  events: [],
  ledgerIncarnationId: 'ledger-a',
  headHrcSeq: 10,
  truncated: false,
}

function clientForStream(
  stream: (options: WatchBoundedEventsOptions) => AsyncIterable<HrcBoundedEventStreamRecord>,
  onTail?: () => void
): AcpHrcClient {
  return {
    async tailEvents() {
      onTail?.()
      return AUTHORITY
    },
    watchBoundedEvents: stream,
  } as unknown as AcpHrcClient
}

async function waitForMessages(
  socket: WebSocket,
  count: number
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for WebSocket records')),
      3000
    )
    socket.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
      if (messages.length === count) {
        clearTimeout(timeout)
        resolve(messages)
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket failed'))
    })
  })
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true })
    socket.close()
  })
}

async function withPluginWebSocketServer<T>(
  hrcClient: AcpHrcClient,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const deps = { hrcClient } as ResolvedAcpServerDeps
  const server = Bun.serve<PluginEventsWebSocketData>({
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (
        request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
        isPluginEventsWebSocketPath(url.pathname) &&
        bunServer.upgrade(request, { data: buildPluginEventsUpgradeData(deps, request.url) })
      ) {
        return undefined
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        void openPluginEventsWebSocket(ws)
      },
      message(ws, message) {
        handlePluginEventsWebSocketMessage(ws, message as string | Buffer)
      },
      close(ws) {
        closePluginEventsWebSocket(ws)
      },
    },
  })
  try {
    return await run(`ws://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

describe('ACP plugin event WebSocket', () => {
  test('resolves fresh authority and forwards ready, canonical event, and ordered gap', async () => {
    let tailReads = 0
    let observedOptions: WatchBoundedEventsOptions | undefined
    const client = clientForStream(
      (options) => {
        observedOptions = options
        return (async function* () {
          yield {
            type: 'ready',
            ledgerIncarnationId: 'ledger-a',
            acceptedAfterHrcSeq: 10,
            replayHeadHrcSeq: 12,
          }
          yield { type: 'event', ledgerIncarnationId: 'ledger-a', event: EVENT }
          yield {
            type: 'gap',
            ledgerIncarnationId: 'ledger-a',
            reason: 'live_queue',
            afterHrcSeq: 11,
            beforeHrcSeq: 12,
            dropped: 1,
          }
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        })()
      },
      () => {
        tailReads += 1
      }
    )

    await withPluginWebSocketServer(client, async (baseUrl) => {
      const socket = new WebSocket(
        `${baseUrl}/v1/plugins/events?after=now&hostSessionId=hsid-1&generation=2&category=turn&eventKind=turn.future`
      )
      const messages = await waitForMessages(socket, 3)
      expect(messages[0]).toEqual({
        type: 'ready',
        ledgerIncarnationId: 'ledger-a',
        acceptedAfterHrcSeq: 10,
        replayHeadHrcSeq: 12,
      })
      expect(messages[0]).not.toHaveProperty('cursor')
      expect(messages[1]).toMatchObject({ type: 'event', event: EVENT })
      const eventCursor = String(messages[1]?.['cursor'])
      expect(decodePluginEventCursor(eventCursor)).toEqual({
        ledgerIncarnationId: 'ledger-a',
        hrcSeq: 11,
      })
      expect(messages[2]).toMatchObject({
        type: 'gap',
        cursor: messages[2]?.['before'],
        reason: 'live_queue',
        dropped: 1,
      })
      expect(decodePluginEventCursor(String(messages[2]?.['after']))).toEqual({
        ledgerIncarnationId: 'ledger-a',
        hrcSeq: 11,
      })
      expect(decodePluginEventCursor(String(messages[2]?.['before']))).toEqual({
        ledgerIncarnationId: 'ledger-a',
        hrcSeq: 12,
      })
      socket.close()
    })

    expect(tailReads).toBe(1)
    expect(observedOptions).toMatchObject({
      ledgerIncarnationId: 'ledger-a',
      afterSeq: 10,
      hostSessionId: 'hsid-1',
      generation: 2,
      category: 'turn',
      eventKind: 'turn.future',
    })
    expect(observedOptions?.signal).toBeInstanceOf(AbortSignal)
  })

  test('maps live ledger replacement to cursor_invalid without forwarding a new-ledger event', async () => {
    const client = clientForStream(() =>
      (async function* () {
        yield {
          type: 'ready',
          ledgerIncarnationId: 'ledger-a',
          acceptedAfterHrcSeq: 10,
          replayHeadHrcSeq: 10,
        }
        yield {
          type: 'ledger_replaced',
          expectedLedgerIncarnationId: 'ledger-a',
          currentLedgerIncarnationId: 'ledger-b',
        }
        yield { type: 'event', ledgerIncarnationId: 'ledger-b', event: EVENT }
      })()
    )
    await withPluginWebSocketServer(client, async (baseUrl) => {
      const socket = new WebSocket(`${baseUrl}/v1/plugins/events?after=now`)
      const messages = await waitForMessages(socket, 2)
      expect(messages).toEqual([
        {
          type: 'ready',
          ledgerIncarnationId: 'ledger-a',
          acceptedAfterHrcSeq: 10,
          replayHeadHrcSeq: 10,
        },
        {
          type: 'error',
          code: 'cursor_invalid',
          message: 'event ledger incarnation is no longer current',
        },
      ])
    })
  })

  test('disconnect after ready reconnects from the original exclusive cursor', async () => {
    const admissions: WatchBoundedEventsOptions[] = []
    const client = clientForStream((options) => {
      admissions.push(options)
      return (async function* () {
        yield {
          type: 'ready',
          ledgerIncarnationId: 'ledger-a',
          acceptedAfterHrcSeq: options.afterSeq,
          replayHeadHrcSeq: 11,
        }
        if (admissions.length > 1) {
          yield { type: 'event', ledgerIncarnationId: 'ledger-a', event: EVENT }
        }
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      })()
    })
    const originalCursor = encodePluginEventCursor({
      ledgerIncarnationId: 'ledger-a',
      hrcSeq: 10,
    })

    await withPluginWebSocketServer(client, async (baseUrl) => {
      const first = new WebSocket(
        `${baseUrl}/v1/plugins/events?after=${encodeURIComponent(originalCursor)}`
      )
      const [ready] = await waitForMessages(first, 1)
      expect(ready).not.toHaveProperty('cursor')
      await closeSocket(first)

      const second = new WebSocket(
        `${baseUrl}/v1/plugins/events?after=${encodeURIComponent(originalCursor)}`
      )
      const messages = await waitForMessages(second, 2)
      expect(messages.map((message) => message['type'])).toEqual(['ready', 'event'])
      expect(decodePluginEventCursor(String(messages[1]?.['cursor']))).toEqual({
        ledgerIncarnationId: 'ledger-a',
        hrcSeq: 11,
      })
      await closeSocket(second)
    })

    expect(admissions).toHaveLength(2)
    expect(admissions.map((admission) => admission.afterSeq)).toEqual([10, 10])
    expect(admissions.map((admission) => admission.ledgerIncarnationId)).toEqual([
      'ledger-a',
      'ledger-a',
    ])
  })

  test('maps pre-admission HRC cursor_invalid to the typed socket error', async () => {
    const client = clientForStream(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HrcBoundedEventStreamRecord>> {
            throw new HrcDomainError(
              'cursor_invalid',
              'event ledger incarnation is no longer current'
            )
          },
        }
      },
    }))
    await withPluginWebSocketServer(client, async (baseUrl) => {
      const socket = new WebSocket(`${baseUrl}/v1/plugins/events?after=now`)
      expect(await waitForMessages(socket, 1)).toEqual([
        {
          type: 'error',
          code: 'cursor_invalid',
          message: 'event ledger incarnation is no longer current',
        },
      ])
    })
  })

  test('stops after one decoded record and closes a non-reading client with 1013', async () => {
    let nextCalls = 0
    let returnCalls = 0
    const client = clientForStream(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HrcBoundedEventStreamRecord>> {
            nextCalls += 1
            return {
              done: false,
              value: {
                type: 'ready',
                ledgerIncarnationId: 'ledger-a',
                acceptedAfterHrcSeq: 10,
                replayHeadHrcSeq: 10,
              },
            }
          },
          async return(): Promise<IteratorResult<HrcBoundedEventStreamRecord>> {
            returnCalls += 1
            return { done: true, value: undefined }
          },
        }
      },
    }))
    const closes: Array<[number | undefined, string | undefined]> = []
    const socket: PluginEventsWebSocketLike = {
      data: buildPluginEventsUpgradeData(
        { hrcClient: client } as ResolvedAcpServerDeps,
        'http://acp.test/v1/plugins/events?after=now'
      ),
      bufferedAmount: Number.MAX_SAFE_INTEGER,
      send() {
        throw new Error('send must not run above the byte ceiling')
      },
      close(code, reason) {
        closes.push([code, reason])
      },
    }

    await openPluginEventsWebSocket(socket)
    expect(nextCalls).toBe(1)
    expect(returnCalls).toBe(1)
    expect(closes).toEqual([[1013, 'slow_consumer']])
    expect(socket.data.abortController.signal.aborted).toBe(true)
  })

  test('asserts exact filters again at the ACP boundary', async () => {
    const sent: Array<Record<string, unknown>> = []
    const closes: Array<[number | undefined, string | undefined]> = []
    const client = clientForStream(() =>
      (async function* () {
        yield {
          type: 'ready',
          ledgerIncarnationId: 'ledger-a',
          acceptedAfterHrcSeq: 10,
          replayHeadHrcSeq: 11,
        }
        yield { type: 'event', ledgerIncarnationId: 'ledger-a', event: EVENT }
      })()
    )
    const socket: PluginEventsWebSocketLike = {
      data: buildPluginEventsUpgradeData(
        { hrcClient: client } as ResolvedAcpServerDeps,
        'http://acp.test/v1/plugins/events?after=now&hostSessionId=another-session'
      ),
      bufferedAmount: 0,
      send(message) {
        sent.push(JSON.parse(message) as Record<string, unknown>)
        return Buffer.byteLength(message)
      },
      close(code, reason) {
        closes.push([code, reason])
      },
    }

    await openPluginEventsWebSocket(socket)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.['type']).toBe('ready')
    expect(sent[1]).toMatchObject({ type: 'error', code: 'filter_assertion_failed' })
    expect(closes).toEqual([[1011, 'filter_assertion_failed']])
  })

  test('ping returns pong without changing stream state', () => {
    const sent: string[] = []
    const socket = {
      data: buildPluginEventsUpgradeData(
        {} as ResolvedAcpServerDeps,
        'http://acp.test/v1/plugins/events?after=now'
      ),
      bufferedAmount: 0,
      send(message: string) {
        sent.push(message)
        return Buffer.byteLength(message)
      },
      close() {},
    }
    handlePluginEventsWebSocketMessage(socket, JSON.stringify({ type: 'ping' }))
    handlePluginEventsWebSocketMessage(socket, 'malformed')
    expect(sent.map((message) => JSON.parse(message))).toEqual([{ type: 'pong' }])
  })

  test('missing after is rejected with a typed protocol error', async () => {
    const client = clientForStream(() => {
      throw new Error('stream must not be opened without an admitted cursor')
    })
    await withPluginWebSocketServer(client, async (baseUrl) => {
      const socket = new WebSocket(`${baseUrl}/v1/plugins/events`)
      expect(await waitForMessages(socket, 1)).toEqual([
        {
          type: 'error',
          code: 'malformed_request',
          message: 'after cursor is required; use after=now to start at the current head',
        },
      ])
    })
  })
})
