/**
 * Tests for GET /v1/ops/session-dashboard/events (NDJSON stream)
 *
 * Spec reference: SESSION_DASHBOARD.md §11.1–§11.3
 *
 * The new /v1/ops/session-dashboard/events endpoint streams DashboardEvent
 * objects (projected from HRC lifecycle events) as NDJSON. It is distinct from
 * the existing /v1/sessions/:sessionId/events which proxies raw HRC events for
 * a single session.
 *
 * Non-goals:
 * - Does NOT test authZ (skipped for Phase 1).
 */
import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import { parseScopeRef } from 'agent-scope'

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
    identity: parseScopeRef(
      overrides.scopeRef ?? 'agent:curly:project:agent-spaces:task:T-01200:role:tester'
    ),
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
    listLatestEventBySession: overrides.listLatestEventBySession ?? (async () => []),
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

  // -- Each filter keeps only matching events ------------------------------

  const TARGET_SCOPE = 'agent:curly:project:agent-spaces:task:T-01200:role:tester'
  const OTHER_SCOPE = 'agent:larry:project:wrkq:task:T-00100:role:implementer'

  test.each([
    {
      filter: 'scopeRef',
      query: `scopeRef=${encodeURIComponent(TARGET_SCOPE)}`,
      events: [
        { hrcSeq: 1, scopeRef: TARGET_SCOPE },
        { hrcSeq: 2, scopeRef: OTHER_SCOPE },
        { hrcSeq: 3, scopeRef: TARGET_SCOPE },
      ],
      expectedSeqs: [1, 3],
    },
    {
      filter: 'laneRef',
      query: 'laneRef=main',
      events: [
        { hrcSeq: 1, laneRef: 'main' },
        { hrcSeq: 2, laneRef: 'repair' },
        { hrcSeq: 3, laneRef: 'main' },
      ],
      expectedSeqs: [1, 3],
    },
    {
      filter: 'hostSessionId',
      query: 'hostSessionId=hsid-target',
      events: [
        { hrcSeq: 1, hostSessionId: 'hsid-target' },
        { hrcSeq: 2, hostSessionId: 'hsid-other' },
        { hrcSeq: 3, hostSessionId: 'hsid-target' },
      ],
      expectedSeqs: [1, 3],
    },
    {
      filter: 'runId',
      query: 'runId=run-aaa',
      events: [
        { hrcSeq: 1, runId: 'run-aaa' },
        { hrcSeq: 2, runId: 'run-bbb' },
        { hrcSeq: 3, runId: 'run-aaa' },
      ],
      expectedSeqs: [1, 3],
    },
    {
      filter: 'runtimeId',
      query: 'runtimeId=rt-001',
      events: [
        { hrcSeq: 1, runtimeId: 'rt-001' },
        { hrcSeq: 2, runtimeId: 'rt-002' },
        { hrcSeq: 3, runtimeId: 'rt-001' },
      ],
      expectedSeqs: [1, 3],
    },
    {
      // projectId matches the stored identity derived from the scopeRef.
      filter: 'projectId',
      query: 'projectId=agent-spaces',
      events: [
        { hrcSeq: 1, scopeRef: TARGET_SCOPE },
        { hrcSeq: 2, scopeRef: OTHER_SCOPE },
      ],
      expectedSeqs: [1],
    },
    {
      // Filters combine with AND semantics.
      filter: 'scopeRef+laneRef+hostSessionId',
      query: `scopeRef=${encodeURIComponent(TARGET_SCOPE)}&laneRef=main&hostSessionId=hsid-combo`,
      events: [
        { hrcSeq: 1, scopeRef: TARGET_SCOPE, laneRef: 'main', hostSessionId: 'hsid-combo' },
        { hrcSeq: 2, scopeRef: TARGET_SCOPE, laneRef: 'repair', hostSessionId: 'hsid-combo' },
        { hrcSeq: 3, scopeRef: TARGET_SCOPE, laneRef: 'main', hostSessionId: 'hsid-other' },
      ],
      expectedSeqs: [1],
    },
  ] satisfies Array<{
    filter: string
    query: string
    events: Array<Partial<HrcCoreLifecycleEvent>>
    expectedSeqs: number[]
  }>)('the $filter filter keeps only matching events', async ({ query, events, expectedSeqs }) => {
    const hrcClient = createHrcClientDouble({
      watch: (_options) =>
        (async function* () {
          for (const overrides of events) yield createHrcEvent(overrides)
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest(query))

        expect(response.status).toBe(200)
        const text = await response.text()
        const received = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        expect(received.map((event) => event.hrcSeq)).toEqual(expectedSeqs)
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
          // tool_execution_start ⇒ family 'tool'
          yield createHrcEvent({
            hrcSeq: 3,
            eventKind: 'turn.tool_call',
            category: 'turn',
            payload: { type: 'tool_execution_start', toolName: 'bash' },
          })
        })(),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(eventsRequest('family=runtime'))

        expect(response.status).toBe(200)
        const text = await response.text()
        const events = parseNdjson(text).filter((e): e is DashboardEvent => e !== null)

        // Only the runtime-family event (session.created) comes through
        expect(events.map((event) => event.hrcSeq)).toEqual([1])
        expect(events[0]!.family).toBe('runtime')
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

        expect(events.map((event) => event.hrcSeq)).toEqual([1, 2, 3, 4, 5])
      },
      { hrcClient }
    )
  })

  // -- Heartbeat blank lines during idle follow ------------------------------

  test('an idle followed stream emits heartbeat blank lines between events', async () => {
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

        // At least one heartbeat blank line sits between the two events while
        // the followed stream is idle (the trailing newline does not count).
        expect(text).toMatch(/\}\n\n+\{/)
      },
      { hrcClient }
    )
  })

  // -- Stream terminates cleanly on client abort -----------------------------

  test('client abort of a followed stream closes the HRC watch', async () => {
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

  test('clamps an old replay cursor to the configured maximum depth', async () => {
    const MANY_EVENTS = 20_000
    let watchedFromSeq: number | undefined

    const hrcClient = createHrcClientDouble({
      listLatestEventBySession: async () => [createHrcEvent({ hrcSeq: MANY_EVENTS })],
      watch: (options) =>
        (async function* () {
          watchedFromSeq = options?.fromSeq
          for (let i = options?.fromSeq ?? 1; i <= MANY_EVENTS; i++) {
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

        expect(watchedFromSeq).toBe(10_001)
        expect(events.length).toBe(10_000)
        expect(events[0]!.hrcSeq).toBe(10_001)
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
          yield createHrcEvent({ hrcSeq: 3, eventKind: 'runtime.created' })
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

  // -- Input admission system events (no HRC client) -----------------------

  test('input admission system events render their admission label, never steered or applied', async () => {
    const adminStore = createInMemoryAdminStore()
    const admissions: Array<{ kind: string; payload: Record<string, unknown> }> = [
      {
        kind: 'input.application.accepted',
        payload: { admissionKind: 'accepted_in_flight', applicationStatus: 'accepted' },
      },
      {
        kind: 'input.application.pending',
        payload: { admissionKind: 'admission_pending', applicationStatus: 'pending' },
      },
      {
        kind: 'input.application.ambiguous',
        payload: { admissionKind: 'admission_pending', applicationStatus: 'ambiguous' },
      },
      {
        kind: 'input.queued',
        payload: {
          admissionKind: 'queued_run',
          applicationStatus: 'failed',
          reason: 'contribution_unsupported_fallback_queued',
        },
      },
      { kind: 'input.queued', payload: { admissionKind: 'queued_run', queueStatus: 'queued' } },
    ]
    admissions.forEach(({ kind, payload }, index) => {
      const occurredAt = `2026-05-07T12:00:0${index}.000Z`
      adminStore.systemEvents.append({
        projectId: 'agent-spaces',
        kind,
        payload: {
          scopeRef: 'agent:curly:project:agent-spaces:task:T-01383',
          laneRef: 'main',
          hostSessionId: 'host-session-labels',
          generation: 1,
          ...payload,
        },
        occurredAt,
        recordedAt: occurredAt,
      })
    })

    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request(eventsRequest())

          expect(response.status).toBe(200)
          const text = await response.text()
          const labels = parseNdjson(text)
            .filter((e): e is DashboardEvent => e !== null)
            .map((event) => event.label)

          expect(labels).toEqual([
            'Contribution accepted',
            'Contribution pending',
            'Contribution ambiguous',
            'Unsupported contribution fallback queued',
            'Queued',
          ])
          for (const label of labels) {
            expect(label).not.toMatch(/\bsteered\b/i)
            expect(label).not.toMatch(/\bapplied\b/i)
          }
        },
        { adminStore }
      )
    } finally {
      adminStore.close?.()
    }
  })
})
