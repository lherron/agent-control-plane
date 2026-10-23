/**
 * logging.md L3: every request line names its `listener`, the registered
 * `route` template the router matched (never the raw path), and the caller's
 * `client` token. Driven through the real listener handlers on a live
 * Bun.serve, so the lines are the ones acp-server.log would get.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { HrcLifecycleEvent } from 'hrc-core'

import { createAcpListenerHandlers } from '../src/acp-listener.js'
import { type AcpHrcClient, resolveAcpServerDeps } from '../src/deps.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LogLine = { level: string; component: string; event: string; data: Record<string, unknown> }

let lines: LogLine[] = []
const originalLog = console.log

beforeEach(() => {
  lines = []
  console.log = (...args: unknown[]) => {
    const text = args.join(' ')
    if (text.startsWith('{')) lines.push(JSON.parse(text) as LogLine)
  }
})

afterEach(() => {
  console.log = originalLog
})

function requestLines(path: string): LogLine[] {
  return lines.filter((line) => line.component === 'http' && line.data['path'] === path)
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const EVENT: HrcLifecycleEvent = {
  hrcSeq: 41,
  streamSeq: 41,
  ts: '2026-10-23T00:00:00.000Z',
  hostSessionId: 'hsid-log-1',
  scopeRef: 'agent:clod:project:agent-control-plane',
  laneRef: 'main',
  generation: 1,
  category: 'turn',
  eventKind: 'turn.message',
  replayed: true,
  payload: {},
}

const hrcClient = {
  watch: () =>
    (async function* () {
      yield EVENT
    })(),
  async tailEvents() {
    return { events: [], ledgerIncarnationId: 'ledger-a', headHrcSeq: 10, truncated: false }
  },
  watchBoundedEvents: (options: { signal?: AbortSignal }) =>
    (async function* () {
      yield {
        type: 'ready',
        ledgerIncarnationId: 'ledger-a',
        acceptedAfterHrcSeq: 10,
        replayHeadHrcSeq: 10,
      }
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    })(),
} as unknown as AcpHrcClient

async function withListener(run: (baseUrl: string) => Promise<void>): Promise<void> {
  await withWiredServer(
    async (fixture) => {
      const handlers = createAcpListenerHandlers({
        acpServer: fixture.server,
        deps: resolveAcpServerDeps(fixture.deps),
        handleCapRpc: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }),
      })
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, ...handlers })
      try {
        await run(`127.0.0.1:${server.port}`)
      } finally {
        server.stop(true)
      }
    },
    { hrcClient }
  )
}

describe('request line listener/route/client', () => {
  test('an exact route logs its path as the route template', async () => {
    await withListener(async (host) => {
      await fetch(`http://${host}/v1/conversation/threads`, {
        headers: { 'user-agent': 'acp-cli/0.1.0 (darwin)' },
      })
    })
    const [line] = requestLines('/v1/conversation/threads')
    expect(line?.event).toBe('http.request')
    expect(line?.data).toMatchObject({
      method: 'GET',
      path: '/v1/conversation/threads',
      route: '/v1/conversation/threads',
      listener: 'main',
      client: 'acp-cli/0.1.0',
      remote: '127.0.0.1',
    })
  })

  test('a param route logs the template, not the raw path', async () => {
    await withListener(async (host) => {
      const response = await fetch(`http://${host}/v1/runs/run-missing-42`, {
        headers: { 'user-agent': 'gateway-discord/0.1.0' },
      })
      expect(response.status).toBe(404)
    })
    const line = await waitFor(() => requestLines('/v1/runs/run-missing-42')[0], 'run line')
    expect(line.event).toBe('http.request')
    expect(line.data).toMatchObject({
      path: '/v1/runs/run-missing-42',
      route: '/v1/runs/:runId',
      listener: 'main',
      client: 'gateway-discord/0.1.0',
      status: 404,
    })
  })

  test('an unrouted path logs route unmatched and an unparseable agent as unknown', async () => {
    await withListener(async (host) => {
      const response = await fetch(`http://${host}/v1/no/such/route`, {
        headers: { 'user-agent': 'not a product token' },
      })
      expect(response.status).toBe(404)
    })
    const line = await waitFor(() => requestLines('/v1/no/such/route')[0], '404 line')
    expect(line.data).toMatchObject({
      path: '/v1/no/such/route',
      route: 'unmatched',
      listener: 'main',
      client: 'unknown',
      status: 404,
      code: 'not_found',
    })
  })

  test('an ndjson stream logs route, listener and client at open and close', async () => {
    const path = '/v1/sessions/hsid-log-1/events'
    await withListener(async (host) => {
      const response = await fetch(`http://${host}${path}?follow=false`, {
        headers: { 'user-agent': 'acp-cli/0.1.0' },
      })
      expect(await response.text()).toContain('hsid-log-1')
    })
    const close = await waitFor(
      () => requestLines(path).find((line) => line.event === 'http.stream.close'),
      'stream close'
    )
    const open = requestLines(path).find((line) => line.event === 'http.stream.open')
    const fields = {
      route: '/v1/sessions/:sessionId/events',
      listener: 'main',
      client: 'acp-cli/0.1.0',
    }
    expect(open?.data).toMatchObject(fields)
    expect(close.data).toMatchObject({ ...fields, outcome: 'end' })
  })

  test('a websocket logs route, listener and client at open and close', async () => {
    const path = '/v1/plugins/events'
    await withListener(async (host) => {
      const socket = new WebSocket(`ws://${host}${path}?after=now`, {
        headers: { 'user-agent': 'gateway-discord/0.1.0' },
      } as unknown as string[])
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('message', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('websocket failed')))
      })
      socket.close(1000)
      await waitFor(
        () => requestLines(path).find((line) => line.event === 'http.stream.close'),
        'websocket close'
      )
    })
    const fields = {
      path,
      route: '/v1/plugins/events',
      listener: 'main',
      client: 'gateway-discord/0.1.0',
      transport: 'websocket',
    }
    const open = requestLines(path).find((line) => line.event === 'http.stream.open')
    const close = requestLines(path).find((line) => line.event === 'http.stream.close')
    expect(open?.data).toMatchObject({ ...fields, status: 101 })
    expect(close?.data).toMatchObject({ ...fields, closeCode: 1000 })
  })

  test('/v1/cap/rpc carries its own route template', async () => {
    await withListener(async (host) => {
      await fetch(`http://${host}/v1/cap/rpc`, {
        method: 'POST',
        headers: { 'user-agent': 'cap/0.3.0', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'cap.provider.list' }),
      })
    })
    const line = await waitFor(() => requestLines('/v1/cap/rpc')[0], 'cap line')
    expect(line.data).toMatchObject({ route: '/v1/cap/rpc', listener: 'main', client: 'cap/0.3.0' })
  })
})
