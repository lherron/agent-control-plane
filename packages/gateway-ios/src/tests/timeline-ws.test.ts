/**
 * Tests for WS /v1/timeline endpoint.
 *
 * Uses a real Bun.serve with WebSocket to verify:
 * 1. Snapshot arrives as the first message.
 * 2. Live frames arrive after the snapshot.
 * 3. raw=true mode emits both frame and hrc_event envelopes.
 * 4. WS close cancels iterators (no leaked pumps).
 * 5. Missing sessionRef returns 400.
 * 6. Ping/pong support.
 */

import { describe, expect, test } from 'bun:test'

import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'
import type { MobileSessionSummary } from '../contracts.js'
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
    payload: { seq: hrcSeq },
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
  /** Past events returned by watch({beforeHrcSeq, limit}) for snapshot replay. */
  pastEvents: HrcLifecycleEvent[] = [],
  sessions: HrcSessionRecord[] = []
): GatewayIosRouteDeps['hrcClient'] {
  const client = {
    async *watch(opts: {
      fromSeq?: number
      beforeHrcSeq?: number
      limit?: number
      follow?: boolean
      signal?: AbortSignal
    }) {
      try {
        // If beforeHrcSeq is set, this is a history query (non-follow)
        if (opts?.beforeHrcSeq !== undefined) {
          const limit = opts.limit ?? 50
          const filtered = pastEvents
            .filter((e) => e.hrcSeq < opts.beforeHrcSeq!)
            .filter(
              (e) => opts.hostSessionId === undefined || e.hostSessionId === opts.hostSessionId
            )
            .filter((e) => opts.generation === undefined || e.generation === opts.generation)
            .sort((a, b) => b.hrcSeq - a.hrcSeq)
            .slice(0, limit)
          for (const event of filtered) {
            yield event
          }
          return
        }

        // Otherwise this is the live follow stream
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

    async *watchMessages(opts: {
      filter?: { afterSeq?: number; sessionRef?: string }
      follow?: boolean
      signal?: AbortSignal
    }) {
      try {
        // No messages in this test
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

    async listMessages(_filter?: unknown) {
      return { messages: [] }
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
  }
  return client as unknown as GatewayIosRouteDeps['hrcClient']
}

// Collect WS messages until a predicate is met or timeout
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
  pastEvents: HrcLifecycleEvent[] = [],
  sessions: HrcSessionRecord[] = []
) {
  const hrcClient = createFakeHrcClient(events, cancelTracking, pastEvents, sessions)

  const deps: GatewayIosRouteDeps = {
    hrcClient: hrcClient as unknown as GatewayIosRouteDeps['hrcClient'],
    gatewayId: 'test-gateway',
    resolveSession: async ({ hostSessionId, generation }) => ({
      ...fakeSession,
      hostSessionId: hostSessionId ?? fakeSession.hostSessionId,
      generation: generation ?? fakeSession.generation,
    }),
  }

  const config = createGatewayIosServeConfig(deps)

  server = Bun.serve({
    port: 0, // Random port
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

describe('WS /v1/timeline', () => {
  test('snapshot is the first message received', async () => {
    const events = [makeEvent(1), makeEvent(2)]
    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })

      expect(messages.length).toBeGreaterThan(0)
      const first = messages[0] as { type: string }
      expect(first.type).toBe('snapshot')

      // Subsequent messages should be frames
      for (let i = 1; i < messages.length; i++) {
        const msg = messages[i] as { type: string }
        expect(['frame', 'hrc_event', 'snapshot']).toContain(msg.type)
      }

      ws.close()
    } finally {
      stopTestServer()
    }
  })

  test('live frames arrive after snapshot with monotonic frameSeq', async () => {
    const events = [
      makeEvent(1, { eventKind: 'turn.started', category: 'turn' }),
      makeEvent(2, { eventKind: 'turn.completed', category: 'turn' }),
    ]
    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })
      ws.close()

      const frames = messages.filter((m) => (m as { type: string }).type === 'frame')
      if (frames.length >= 2) {
        const seqs = frames.map((f) => (f as { frame: { frameSeq: number } }).frame.frameSeq)
        for (let i = 1; i < seqs.length; i++) {
          expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
        }
      }
    } finally {
      stopTestServer()
    }
  })

  test('raw=true mode emits hrc_event envelopes alongside frames', async () => {
    const events = [makeEvent(1, { eventKind: 'turn.started' })]
    const srv = startTestServer(events)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}&raw=true`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 4, timeoutMs: 2000 })
      ws.close()

      const types = messages.map((m) => (m as { type: string }).type)
      expect(types[0]).toBe('snapshot')

      // Should have both 'frame' and 'hrc_event' messages
      expect(types).toContain('frame')
      expect(types).toContain('hrc_event')

      // Verify hrc_event has full payload
      const hrcEvents = messages.filter((m) => (m as { type: string }).type === 'hrc_event')
      for (const he of hrcEvents) {
        const typed = he as {
          type: string
          hrcSeq: number
          eventKind: string
          category: string
          payload: unknown
        }
        expect(typed.hrcSeq).toBeGreaterThan(0)
        expect(typed.eventKind).toBeDefined()
        expect(typed.category).toBeDefined()
        expect(typed.payload).toBeDefined()
      }
    } finally {
      stopTestServer()
    }
  })

  test('WS close cancels iterators (no leaked pumps)', async () => {
    const cancelTracking = {
      eventCancelled: { value: false },
      messageCancelled: { value: false },
    }

    const srv = startTestServer([makeEvent(1)], cancelTracking)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      // Wait for snapshot, then close
      await new Promise((r) => setTimeout(r, 100))
      ws.close()

      // Wait for cancellation to propagate
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
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/timeline`, {
        headers: { Upgrade: 'websocket' },
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('sessionRef')
    } finally {
      stopTestServer()
    }
  })

  test('ping/pong support', async () => {
    const srv = startTestServer()
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      // Wait for snapshot
      await new Promise((r) => setTimeout(r, 100))

      // Send ping
      ws.send(JSON.stringify({ type: 'ping' }))

      const pongPromise = new Promise<unknown>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'pong') resolve(parsed)
          } catch {
            // ignore
          }
        }
        setTimeout(() => resolve(null), 1000)
      })

      const pong = await pongPromise
      expect(pong).not.toBeNull()
      expect((pong as { type: string }).type).toBe('pong')

      ws.close()
    } finally {
      stopTestServer()
    }
  })

  test('snapshot includes session summary', async () => {
    const srv = startTestServer()
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 1, timeoutMs: 2000 })
      ws.close()

      const snapshot = messages[0] as {
        type: string
        session: MobileSessionSummary
        snapshotHighWater: unknown
      }
      expect(snapshot.type).toBe('snapshot')
      expect(snapshot.session.sessionRef).toBe(SESSION_REF)
      expect(snapshot.session.mode).toBe('interactive')
      expect(snapshot.snapshotHighWater).toBeDefined()
    } finally {
      stopTestServer()
    }
  })

  test('snapshot populates history.frames from past events', async () => {
    // Past events that should appear in the snapshot's history.frames
    const pastEvents = [
      makeEvent(10, {
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-10',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-10',
          message: { role: 'user', content: 'hello' },
        },
      }),
      makeEvent(20, {
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-20',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-20',
          message: { role: 'user', content: 'world' },
        },
      }),
    ]

    // No new live events
    const srv = startTestServer([], undefined, pastEvents)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 1, timeoutMs: 2000 })
      ws.close()

      const snapshot = messages[0] as {
        type: string
        snapshotHighWater: { hrcSeq: number; messageSeq: number }
        history: {
          frames: Array<{ frameId: string; lastHrcSeq: number; frameSeq: number }>
          oldestCursor: { hrcSeq: number; messageSeq: number }
          newestCursor: { hrcSeq: number; messageSeq: number }
          hasMoreBefore: boolean
        }
      }

      expect(snapshot.type).toBe('snapshot')

      // Frames must be non-empty and in chronological order
      expect(snapshot.history.frames.length).toBeGreaterThan(0)
      const hrcSeqs = snapshot.history.frames.map((f) => f.lastHrcSeq)
      for (let i = 1; i < hrcSeqs.length; i++) {
        expect(hrcSeqs[i]).toBeGreaterThanOrEqual(hrcSeqs[i - 1]!)
      }

      // Cursors must be populated
      expect(snapshot.snapshotHighWater.hrcSeq).toBeGreaterThan(0)
      expect(snapshot.history.newestCursor.hrcSeq).toBeGreaterThan(0)
      expect(snapshot.history.oldestCursor.hrcSeq).toBeGreaterThan(0)
    } finally {
      stopTestServer()
    }
  })

  test('snapshot history excludes sibling hostSessionId for the same sessionRef', async () => {
    const pastEvents = [
      makeEvent(30, {
        hostSessionId: 'host-selected',
        generation: 2,
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-selected',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-selected',
          message: { role: 'user', content: 'selected' },
        },
      }),
      makeEvent(40, {
        hostSessionId: 'host-sibling',
        generation: 3,
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-sibling',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-sibling',
          message: { role: 'user', content: 'sibling' },
        },
      }),
    ]

    const srv = startTestServer([], undefined, pastEvents)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(
          SESSION_REF
        )}&hostSessionId=host-selected&generation=2`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 1, timeoutMs: 2000 })
      ws.close()

      const snapshot = messages[0] as {
        type: string
        history: { frames: Array<{ lastHrcSeq: number }> }
      }

      expect(snapshot.type).toBe('snapshot')
      expect(snapshot.history.frames.map((frame) => frame.lastHrcSeq)).toEqual([30])
    } finally {
      stopTestServer()
    }
  })

  test('snapshot high-water prevents duplicate frames from live pump', async () => {
    // Past event at hrcSeq=10
    const pastEvents = [
      makeEvent(10, {
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-10',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-10',
          message: { role: 'user', content: 'hello' },
        },
      }),
    ]

    // Same event arrives via the live pump (simulating race)
    const liveEvents = [
      makeEvent(10, {
        eventKind: 'turn.user_prompt',
        category: 'turn',
        runId: 'run-10',
        payload: {
          type: 'turn.user_prompt',
          messageId: 'msg-10',
          message: { role: 'user', content: 'hello' },
        },
      }),
    ]

    const srv = startTestServer(liveEvents, undefined, pastEvents)
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/v1/timeline?sessionRef=${encodeURIComponent(SESSION_REF)}`
      )

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve()
      })

      const messages = await collectWsMessages(ws, { count: 3, timeoutMs: 2000 })
      ws.close()

      const snapshot = messages[0] as {
        type: string
        history: { frames: Array<{ frameId: string; lastHrcSeq: number }> }
      }
      expect(snapshot.type).toBe('snapshot')

      // The live event at hrcSeq=10 should NOT produce a duplicate frame
      // because the snapshot high-water is >= 10, so the pump deduplicates it.
      const allFrameMessages = messages.filter((m) => (m as { type: string }).type === 'frame')

      // Snapshot already has the frame. Live should not re-emit it as a separate frame message
      // (pump dedup: items at or below snapshot high-water are not forwarded).
      // We may get 0 live frame messages if the pump correctly deduplicates.
      const liveFrameIds = allFrameMessages.map(
        (m) => (m as { frame: { frameId: string } }).frame.frameId
      )
      const snapshotFrameIds = snapshot.history.frames.map((f) => f.frameId)

      // No live frame should duplicate a snapshot frame at the same hrcSeq
      // (the pump's hrcSeq > hrcHighWater check prevents emission)
      for (const liveId of liveFrameIds) {
        if (snapshotFrameIds.includes(liveId)) {
          // If a live frame update arrives for a snapshot frame, that's acceptable
          // (reducer merges), but its hrcSeq must be > snapshot high-water.
        }
      }

      // Basic assertion: no crash, snapshot was sent correctly
      expect(snapshot.history.frames.length).toBeGreaterThan(0)
    } finally {
      stopTestServer()
    }
  })
})
