/**
 * Red tests for GET /v1/ops/session-dashboard/events (NDJSON stream)
 *
 * Spec reference: SESSION_DASHBOARD.md §11.1–§11.3
 *
 * These tests exercise the dashboard event stream endpoint contract. They are
 * intentionally RED — the route is not yet wired and no handler exists.
 *
 * The new /v1/ops/session-dashboard/events endpoint streams DashboardEvent
 * objects (projected from HRC lifecycle events) as NDJSON. It is distinct from
 * the existing /v1/sessions/:sessionId/events which proxies raw HRC events for
 * a single session.
 *
 * Non-goals:
 * - Does NOT test authZ (skipped for Phase 1).
 * - Does NOT implement the handler.
 * - Does NOT touch handlers/sessions-events.ts (existing per-session proxy).
 */
import { describe, expect, test } from 'bun:test'

import type { DashboardEvent } from 'acp-ops-projection'
import type { HrcLifecycleEvent as HrcCoreLifecycleEvent } from 'hrc-core'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVENTS_PATH = '/v1/ops/session-dashboard/events'

function eventsRequest(query = ''): { method: string; path: string } {
  const qs = query.length > 0 ? `?${query}` : ''
  return { method: 'GET', path: `${EVENTS_PATH}${qs}` }
}

/**
 * Create a minimal HRC lifecycle event compatible with hrc-core's HrcLifecycleEvent.
 * The watch() method on HrcClient yields hrc-core HrcLifecycleEvent objects.
 */
function createHrcEvent(overrides: Partial<HrcCoreLifecycleEvent> = {}): HrcCoreLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-04-23T12:00:00.000Z',
    hostSessionId: 'hsid-dash-001',
    scopeRef: 'agent:curly:project:agent-spaces:task:T-01200:role:tester',
    laneRef: 'main',
    generation: 1,
    category: 'session',
    eventKind: 'session.created',
    replayed: false,
    payload: { type: 'session_created' },
    ...overrides,
  }
}

function createHrcClientDouble(overrides: Partial<AcpHrcClient> = {}): AcpHrcClient {
  const notImplemented = (name: string) => async () => {
    throw new Error(`${name} not implemented`)
  }

  return {
    resolveSession:
      overrides.resolveSession ??
      (notImplemented('resolveSession') as unknown as AcpHrcClient['resolveSession']),
    listSessions:
      overrides.listSessions ??
      (notImplemented('listSessions') as unknown as AcpHrcClient['listSessions']),
    getSession:
      overrides.getSession ??
      (notImplemented('getSession') as unknown as AcpHrcClient['getSession']),
    clearContext:
      overrides.clearContext ??
      (notImplemented('clearContext') as unknown as AcpHrcClient['clearContext']),
    listRuntimes:
      overrides.listRuntimes ??
      (notImplemented('listRuntimes') as unknown as AcpHrcClient['listRuntimes']),
    capture: overrides.capture ?? (notImplemented('capture') as unknown as AcpHrcClient['capture']),
    getAttachDescriptor:
      overrides.getAttachDescriptor ??
      (notImplemented('getAttachDescriptor') as unknown as AcpHrcClient['getAttachDescriptor']),
    interrupt:
      overrides.interrupt ?? (notImplemented('interrupt') as unknown as AcpHrcClient['interrupt']),
    terminate:
      overrides.terminate ?? (notImplemented('terminate') as unknown as AcpHrcClient['terminate']),
    watch:
      overrides.watch ??
      // biome-ignore lint/correctness/useYield: test double that throws on use
      (async function* () {
        throw new Error('watch not implemented')
      } as unknown as AcpHrcClient['watch']),
  }
}

/**
 * Parse an NDJSON response body into an array of parsed lines.
 * Empty lines (heartbeats) are preserved as null.
 */
function parseNdjson(text: string): Array<DashboardEvent | null> {
  return text
    .split('\n')
    .filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0) // strip trailing newline
    .map((line) => (line.trim().length === 0 ? null : (JSON.parse(line) as DashboardEvent)))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/ops/session-dashboard/events', () => {
  // -- Content-Type ----------------------------------------------------------

  test('responds with application/x-ndjson content type', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          // empty stream
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest())

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/x-ndjson')
      },
      { hrcClient }
    )
  })

  // -- Replay from fromSeq in order -----------------------------------------

  test('replays events from fromSeq in order', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 10, eventKind: 'session.created' })
          yield createHrcEvent({ hrcSeq: 11, eventKind: 'runtime.launched' })
          yield createHrcEvent({ hrcSeq: 12, eventKind: 'turn.message' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('fromSeq=10'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(3)
        // Verify ordering by hrcSeq
        expect(events[0]!.hrcSeq).toBe(10)
        expect(events[1]!.hrcSeq).toBe(11)
        expect(events[2]!.hrcSeq).toBe(12)
      },
      { hrcClient }
    )
  })

  // -- Filtering by scopeRef ------------------------------------------------

  test('filters events by scopeRef', async () => {
    const targetScope = 'agent:curly:project:agent-spaces:task:T-01200:role:tester'
    const otherScope = 'agent:larry:project:wrkq:task:T-00100:role:implementer'

    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, scopeRef: targetScope })
          yield createHrcEvent({ hrcSeq: 2, scopeRef: otherScope })
          yield createHrcEvent({ hrcSeq: 3, scopeRef: targetScope })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(
          eventsRequest(`scopeRef=${encodeURIComponent(targetScope)}`)
        )

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
        for (const event of events) {
          expect(event.sessionRef.scopeRef).toBe(targetScope)
        }
      },
      { hrcClient }
    )
  })

  // -- Filtering by laneRef -------------------------------------------------

  test('filters events by laneRef', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, laneRef: 'main' })
          yield createHrcEvent({ hrcSeq: 2, laneRef: 'repair' })
          yield createHrcEvent({ hrcSeq: 3, laneRef: 'main' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('laneRef=main'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
        for (const event of events) {
          expect(event.sessionRef.laneRef).toBe('main')
        }
      },
      { hrcClient }
    )
  })

  // -- Filtering by hostSessionId -------------------------------------------

  test('filters events by hostSessionId', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, hostSessionId: 'hsid-target' })
          yield createHrcEvent({ hrcSeq: 2, hostSessionId: 'hsid-other' })
          yield createHrcEvent({ hrcSeq: 3, hostSessionId: 'hsid-target' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('hostSessionId=hsid-target'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
        for (const event of events) {
          expect(event.hostSessionId).toBe('hsid-target')
        }
      },
      { hrcClient }
    )
  })

  // -- Filtering by runId ---------------------------------------------------

  test('filters events by runId', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, runId: 'run-aaa' })
          yield createHrcEvent({ hrcSeq: 2, runId: 'run-bbb' })
          yield createHrcEvent({ hrcSeq: 3, runId: 'run-aaa' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('runId=run-aaa'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
        for (const event of events) {
          expect(event.runId).toBe('run-aaa')
        }
      },
      { hrcClient }
    )
  })

  // -- Filtering by runtimeId -----------------------------------------------

  test('filters events by runtimeId', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, runtimeId: 'rt-001' })
          yield createHrcEvent({ hrcSeq: 2, runtimeId: 'rt-002' })
          yield createHrcEvent({ hrcSeq: 3, runtimeId: 'rt-001' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('runtimeId=rt-001'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
        for (const event of events) {
          expect(event.runtimeId).toBe('rt-001')
        }
      },
      { hrcClient }
    )
  })

  // -- Filtering by projectId -----------------------------------------------

  test('filters events by projectId', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({
            hrcSeq: 1,
            scopeRef: 'agent:curly:project:agent-spaces:task:T-01200:role:tester',
          })
          yield createHrcEvent({
            hrcSeq: 2,
            scopeRef: 'agent:larry:project:wrkq:task:T-00100:role:implementer',
          })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('projectId=agent-spaces'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // Only the event whose scopeRef contains project:agent-spaces should match
        expect(events.length).toBe(1)
        expect(events[0]!.sessionRef.scopeRef).toContain('project:agent-spaces')
      },
      { hrcClient }
    )
  })

  // -- Family filter applies AFTER projection --------------------------------

  test('family filter applies AFTER projection (filters on DashboardEvent.family)', async () => {
    // The family field exists on DashboardEvent, NOT on raw HrcLifecycleEvent.
    // The handler must project HRC events into DashboardEvents first, then filter
    // by the family query param.
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          // session.created ⇒ family 'runtime'
          yield createHrcEvent({ hrcSeq: 1, eventKind: 'session.created', category: 'session' })
          // turn.message ⇒ family 'agent_message'
          yield createHrcEvent({
            hrcSeq: 2,
            eventKind: 'turn.message',
            category: 'turn',
            payload: { type: 'message_end', message: { role: 'assistant', content: [] } },
          })
          // tool.call ⇒ family 'tool'
          yield createHrcEvent({
            hrcSeq: 3,
            eventKind: 'turn.tool_use',
            category: 'turn',
            payload: { type: 'tool_use', name: 'bash' },
          })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('family=runtime'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // Only runtime-family events should come through
        for (const event of events) {
          expect(event.family).toBe('runtime')
        }
      },
      { hrcClient }
    )
  })

  // -- Limit parameter -------------------------------------------------------

  test('respects limit parameter for replay', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          for (let i = 1; i <= 20; i++) {
            yield createHrcEvent({ hrcSeq: i })
          }
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('limit=5'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBeLessThanOrEqual(5)
      },
      { hrcClient }
    )
  })

  // -- Heartbeat blank lines during idle follow ------------------------------

  test('emits heartbeat blank lines during idle follow', async () => {
    let _yieldControl: (() => void) | undefined
    const _waitForYield = new Promise<void>((resolve) => {
      _yieldControl = resolve
    })

    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1 })
          // Simulate idle period — the handler should emit heartbeat blank lines
          // We resolve after a brief pause to let heartbeats emit
          await new Promise<void>((resolve) => setTimeout(resolve, 200))
          yield createHrcEvent({ hrcSeq: 2 })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('follow=true'))

        expect(response.status).toBe(200)
        const text = await response.text()

        // The response should contain at least one blank line (heartbeat)
        // between events when following an idle stream
        const lines = text.split('\n')
        const blankLines = lines.filter((line) => line.trim().length === 0)
        expect(blankLines.length).toBeGreaterThan(0)
      },
      { hrcClient }
    )
  })

  // -- Stream terminates cleanly on client abort -----------------------------

  test('terminates cleanly when client aborts', async () => {
    let generatorClosed = false

    const hrcClient = createHrcClientDouble({
      watch: (_options) => {
        const gen = (async function* () {
          try {
            yield createHrcEvent({ hrcSeq: 1 })
            // Hang indefinitely — client abort should terminate us
            await new Promise<void>(() => {})
          } finally {
            generatorClosed = true
          }
        })()
        return gen
      },
    })

    await withWiredServer(
      async (fixture) => {
        const controller = new AbortController()
        const response = await fixture.handler(
          new Request(`http://acp.test${EVENTS_PATH}?follow=true`, {
            method: 'GET',
            signal: controller.signal,
          })
        )

        expect(response.status).toBe(200)

        // Read first chunk then abort
        const reader = response.body!.getReader()
        const firstChunk = await reader.read()
        expect(firstChunk.done).toBe(false)

        // Abort the request
        controller.abort()
        reader.releaseLock()

        // Give the handler a tick to clean up
        await new Promise<void>((resolve) => setTimeout(resolve, 50))

        // Generator should have been closed via finally
        expect(generatorClosed).toBe(true)
      },
      { hrcClient }
    )
  })

  // -- No unbounded buffering -----------------------------------------------

  test('does not buffer unbounded events in memory during replay', async () => {
    // Emit a large number of events. The handler should stream them out
    // incrementally, not collect them all in memory first.
    const MANY_EVENTS = 10_000
    let _emittedCount = 0

    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          for (let i = 1; i <= MANY_EVENTS; i++) {
            _emittedCount = i
            yield createHrcEvent({ hrcSeq: i })
          }
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('fromSeq=1'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // All events should have been streamed
        expect(events.length).toBe(MANY_EVENTS)
        // Verify none were lost or reordered
        expect(events[0]!.hrcSeq).toBe(1)
        expect(events[events.length - 1]!.hrcSeq).toBe(MANY_EVENTS)
      },
      { hrcClient }
    )
  })

  // -- Malformed HRC events are skipped -------------------------------------

  test('skips malformed HRC events and continues stream', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1, eventKind: 'session.created' })
          // Malformed: missing required fields
          yield { hrcSeq: 2 } as unknown as HrcCoreLifecycleEvent
          yield createHrcEvent({ hrcSeq: 3, eventKind: 'session.resolved' })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('fromSeq=1'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // The malformed event (hrcSeq=2) should be skipped; events 1 and 3 remain
        expect(events.length).toBe(2)
        expect(events[0]!.hrcSeq).toBe(1)
        expect(events[1]!.hrcSeq).toBe(3)
      },
      { hrcClient }
    )
  })

  // -- DashboardEvent shape on the wire -------------------------------------

  test('each NDJSON line is a well-typed DashboardEvent', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({
            hrcSeq: 42,
            hostSessionId: 'hsid-shape-check',
            scopeRef: 'agent:curly:project:agent-spaces:task:T-01200:role:tester',
            laneRef: 'main',
            generation: 1,
            eventKind: 'session.created',
            category: 'session',
          })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('fromSeq=42'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(1)
        const event = events[0]!

        // Verify DashboardEvent shape (§8.4)
        expect(typeof event.id).toBe('string')
        expect(event.hrcSeq).toBe(42)
        expect(typeof event.ts).toBe('string')
        expect(event.sessionRef).toBeDefined()
        expect(typeof event.sessionRef.scopeRef).toBe('string')
        expect(typeof event.sessionRef.laneRef).toBe('string')
        expect(typeof event.hostSessionId).toBe('string')
        expect(typeof event.generation).toBe('number')
        expect(typeof event.eventKind).toBe('string')
        expect(typeof event.family).toBe('string')
        expect(['info', 'success', 'warning', 'error']).toContain(event.severity)
        expect(typeof event.label).toBe('string')
        expect(typeof event.redacted).toBe('boolean')
      },
      { hrcClient }
    )
  })

  // -- Combined filters work together ----------------------------------------

  test('combines scopeRef, laneRef, and hostSessionId filters', async () => {
    const targetScope = 'agent:curly:project:agent-spaces:task:T-01200:role:tester'

    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({
            hrcSeq: 1,
            scopeRef: targetScope,
            laneRef: 'main',
            hostSessionId: 'hsid-combo',
          })
          yield createHrcEvent({
            hrcSeq: 2,
            scopeRef: targetScope,
            laneRef: 'repair',
            hostSessionId: 'hsid-combo',
          })
          yield createHrcEvent({
            hrcSeq: 3,
            scopeRef: targetScope,
            laneRef: 'main',
            hostSessionId: 'hsid-other',
          })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const qs = `scopeRef=${encodeURIComponent(targetScope)}&laneRef=main&hostSessionId=hsid-combo`
        const response = await fixture.request(eventsRequest(qs))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // Only event with hrcSeq=1 matches all three filters
        expect(events.length).toBe(1)
        expect(events[0]!.hrcSeq).toBe(1)
      },
      { hrcClient }
    )
  })

  // -- follow=false terminates after replay ----------------------------------

  test('follow=false terminates stream after replay completes', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          yield createHrcEvent({ hrcSeq: 1 })
          yield createHrcEvent({ hrcSeq: 2 })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('follow=false&fromSeq=1'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(events.length).toBe(2)
      },
      { hrcClient }
    )
  })

  // -- Empty stream returns 200 with no events -------------------------------

  test('returns 200 with empty body for empty event stream', async () => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          // no events
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest())

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/x-ndjson')

        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)
        expect(events.length).toBe(0)
      },
      { hrcClient }
    )
  })
})
