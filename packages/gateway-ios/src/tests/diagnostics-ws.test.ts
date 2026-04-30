/**
 * Tests for WS /v1/diagnostics/events endpoint.
 *
 * Verifies:
 * 1. Raw HRC events are emitted with full payload.
 * 2. eventKind and category are preserved (not projected).
 * 3. Category filter restricts which events are emitted.
 * 4. EventKind filter restricts which events are emitted.
 * 5. No projection — only hrc_event envelopes (no frame envelopes).
 * 6. Cancel test: iterators cancelled on WS close.
 */

import { describe, expect, test } from 'bun:test'

import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'
import type { MobileSessionSummary } from '../contracts.js'
import type { EventPumpHrcClient } from '../event-pump.js'
import { type GatewayIosRouteDeps, createGatewayIosServeConfig } from '../routes.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_REF = 'agent:cody:project:agent-spaces/lane:main'

function makeEvent(hrcSeq: number, overrides?: Partial<HrcLifecycleEvent>): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date().toISOString(),
    hostSessionId: 'host-1',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.started',
    replayed: false,
    payload: { type: 'test', seq: hrcSeq },
    ...overrides,
  }
}

const fakeSession: MobileSessionSummary = {
  sessionRef: SESSION_REF,
  displayRef: 'cody@agent-spaces',
  title: 'cody',
  mode: 'interactive',
  executionMode: 'interactive',
  status: 'active',
  hostSessionId: 'host-1',
  generation: 1,
  runtimeId: 'rt-1',
  activeTurnId: null,
  lastHrcSeq: 0,
  lastMessageSeq: 0,
  lastActivityAt: null,
  capabilities: {
    input: true,
    interrupt: true,
    launchHeadlessTurn: false,
    history: true,
  },
}

function createFakeHrcClient(
  events: HrcLifecycleEvent[] = [],
  cancelTracking?: { eventCancelled: { value: boolean }; messageCancelled: { value: boolean } },
  sessions: HrcSessionRecord[] = []
): EventPumpHrcClient {
  return {
    async *watch(opts) {
      try {
        for (const event of events) {
          if (opts?.signal?.aborted) return
          if (opts?.hostSessionId !== undefined && event.hostSessionId !== opts.hostSessionId) {
            continue
          }
          if (opts?.generation !== undefined && event.generation !== opts.generation) {
            continue
          }
          yield event
        }
        if (opts?.follow) {
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              resolve()
              return
            }
            opts?.signal?.addEventListener('abort', () => resolve())
          })
        }
      } finally {
        if (cancelTracking) cancelTracking.eventCancelled.value = true
      }
    },

    async *watchMessages(opts) {
      try {
        if (opts?.follow) {
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              resolve()
              return
            }
            opts?.signal?.addEventListener('abort', () => resolve())
          })
        }
      } finally {
        if (cancelTracking) cancelTracking.messageCancelled.value = true
      }
    },
    async listSessions() {
      return sessions.length > 0
        ? sessions
        : [
            {
              hostSessionId: 'host-1',
              scopeRef: 'agent:cody:project:agent-spaces',
              laneRef: 'main',
              generation: 1,
              status: 'active',
              createdAt: '2026-04-30T10:00:00.000Z',
              updatedAt: '2026-04-30T10:00:00.000Z',
              ancestorScopeRefs: [],
            },
          ]
    },
  } as unknown as EventPumpHrcClient
}

async function collectWsMessages(
  ws: WebSocket,
  opts: { count?: number; timeoutMs?: number } = {}
): Promise<unknown[]> {
  const count = opts.count ?? 10
  const timeoutMs = opts.timeoutMs ?? 2000
  const messages: unknown[] = []

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close()
      resolve(messages)
    }, timeoutMs)

    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(ev.data as string))
      } catch {
        messages.push(ev.data)
      }
      if (messages.length >= count) {
        clearTimeout(timer)
        resolve(messages)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | undefined

function startTestServer(
  events: HrcLifecycleEvent[] = [],
  cancelTracking?: { eventCancelled: { value: boolean }; messageCancelled: { value: boolean } },
  sessions: HrcSessionRecord[] = []
) {
  const hrcClient = createFakeHrcClient(events, cancelTracking, sessions)

  const deps: GatewayIosRouteDeps = {
    hrcClient: hrcClient as unknown as GatewayIosRouteDeps['hrcClient'],
    gatewayId: 'test-gateway',
    resolveSession: async () => fakeSession,
  }

  const config = createGatewayIosServeConfig(deps)

  server = Bun.serve({
    port: 0,
    fetch: config.fetch,
    websocket: config.websocket,
  })

  return server
}

function stopTestServer() {
  server?.stop(true)
  server = undefined
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WS /v1/diagnostics/events', () => {
  test('emits raw HRC events with full payload, eventKind, and category preserved', async () => {
    const events = [
      makeEvent(1, {
        category: 'turn',
        eventKind: 'turn.started',
        payload: { type: 'turn_started', details: 'full payload here' },
      }),
      makeEvent(2, {
        category: 'session',
        eventKind: 'session.created',
        payload: { type: 'session_created', more: 'data' },
      }),
    ]

    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/diagnostics/events?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      // snapshot + 2 hrc_event
      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })
      ws.close()

      // First message is a snapshot
      expect((messages[0] as { type: string }).type).toBe('snapshot')

      // Remaining messages are hrc_event (NOT frame)
      const hrcEvents = messages.filter((m) => (m as { type: string }).type === 'hrc_event')
      expect(hrcEvents.length).toBe(2)

      // Verify full payload preservation
      const first = hrcEvents[0] as {
        type: string
        hrcSeq: number
        eventKind: string
        category: string
        payload: unknown
      }
      expect(first.hrcSeq).toBe(1)
      expect(first.eventKind).toBe('turn.started')
      expect(first.category).toBe('turn')
      expect(first.payload).toEqual({ type: 'turn_started', details: 'full payload here' })

      const second = hrcEvents[1] as {
        type: string
        hrcSeq: number
        eventKind: string
        category: string
        payload: unknown
      }
      expect(second.hrcSeq).toBe(2)
      expect(second.eventKind).toBe('session.created')
      expect(second.category).toBe('session')
      expect(second.payload).toEqual({ type: 'session_created', more: 'data' })

      // NO frame envelopes should exist
      const frames = messages.filter((m) => (m as { type: string }).type === 'frame')
      expect(frames.length).toBe(0)
    } finally {
      stopTestServer()
    }
  })

  test('category filter: only events matching the category are emitted', async () => {
    const events = [
      makeEvent(1, { category: 'turn', eventKind: 'turn.started' }),
      makeEvent(2, { category: 'session', eventKind: 'session.created' }),
      makeEvent(3, { category: 'turn', eventKind: 'turn.completed' }),
      makeEvent(4, { category: 'runtime', eventKind: 'runtime.created' }),
    ]

    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/diagnostics/events?sessionRef=${encodeURIComponent(SESSION_REF)}&category=turn`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      // snapshot + 2 turn events
      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })
      ws.close()

      const hrcEvents = messages.filter((m) => (m as { type: string }).type === 'hrc_event')
      expect(hrcEvents.length).toBe(2)

      // Only turn events should be present
      for (const event of hrcEvents) {
        expect((event as { category: string }).category).toBe('turn')
      }
    } finally {
      stopTestServer()
    }
  })

  test('eventKind filter: only events matching the eventKind are emitted', async () => {
    const events = [
      makeEvent(1, { category: 'turn', eventKind: 'turn.started' }),
      makeEvent(2, { category: 'turn', eventKind: 'turn.completed' }),
      makeEvent(3, { category: 'turn', eventKind: 'turn.started' }),
    ]

    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/diagnostics/events?sessionRef=${encodeURIComponent(SESSION_REF)}&eventKind=turn.started`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      // snapshot + 2 turn.started events
      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })
      ws.close()

      const hrcEvents = messages.filter((m) => (m as { type: string }).type === 'hrc_event')
      expect(hrcEvents.length).toBe(2)

      for (const event of hrcEvents) {
        expect((event as { eventKind: string }).eventKind).toBe('turn.started')
      }
    } finally {
      stopTestServer()
    }
  })

  test('absent hostSessionId resolves diagnostics to active latest generation only', async () => {
    const events = [
      makeEvent(10, { hostSessionId: 'host-old', generation: 1 }),
      makeEvent(11, { hostSessionId: 'host-latest', generation: 3 }),
    ]
    const sessions: HrcSessionRecord[] = [
      {
        hostSessionId: 'host-old',
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
        generation: 1,
        status: 'inactive',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T10:00:00.000Z',
        ancestorScopeRefs: [],
      },
      {
        hostSessionId: 'host-latest',
        scopeRef: 'agent:cody:project:agent-spaces',
        laneRef: 'main',
        generation: 3,
        status: 'active',
        createdAt: '2026-04-30T10:00:00.000Z',
        updatedAt: '2026-04-30T10:05:00.000Z',
        ancestorScopeRefs: [],
      },
    ]

    const srv = startTestServer(events, undefined, sessions)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/diagnostics/events?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 2, timeoutMs: 2000 })
      ws.close()

      const hrcEvents = messages.filter((m) => (m as { type: string }).type === 'hrc_event')
      expect(hrcEvents.map((event) => (event as { hrcSeq: number }).hrcSeq)).toEqual([11])
      expect(
        (messages[0] as { session: { hostSessionId: string; generation: number } }).session
      ).toMatchObject({
        hostSessionId: 'host-latest',
        generation: 3,
      })
    } finally {
      stopTestServer()
    }
  })

  test('cancel: iterators are cancelled on WS close', async () => {
    const cancelTracking = {
      eventCancelled: { value: false },
      messageCancelled: { value: false },
    }

    const srv = startTestServer([makeEvent(1)], cancelTracking)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/diagnostics/events?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })
      await new Promise((r) => setTimeout(r, 100))

      ws.close()
      await new Promise((r) => setTimeout(r, 200))

      expect(cancelTracking.eventCancelled.value).toBe(true)
      expect(cancelTracking.messageCancelled.value).toBe(true)
    } finally {
      stopTestServer()
    }
  })

  test('missing sessionRef returns 400', async () => {
    const srv = startTestServer()
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/diagnostics/events`, {
        headers: { Upgrade: 'websocket' },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('sessionRef')
    } finally {
      stopTestServer()
    }
  })
})
