import { describe, expect, test } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

const EVENTS_PATH = '/v1/session-refs/events'
const SESSION_REF = 'agent:larry:project:agent-spaces/lane:main'
const SCOPE_REF = 'agent:larry:project:agent-spaces'

function eventsRequest(query: string): { method: string; path: string } {
  return { method: 'GET', path: `${EVENTS_PATH}?${query}` }
}

function createLifecycleEvent(overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq: 1,
    streamSeq: 1,
    ts: '2026-05-06T00:00:00.000Z',
    hostSessionId: 'hsid-events-001',
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind: 'turn.message',
    payload: { type: 'message_end' },
    ...overrides,
  }
}

function createHrcClientDouble(watch: AcpHrcClient['watch']): AcpHrcClient {
  return {
    watch,
  } as AcpHrcClient
}

function parseNdjson(text: string): HrcLifecycleEvent[] {
  if (!text.trim()) return []
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HrcLifecycleEvent)
}

describe('GET /v1/session-refs/events', () => {
  test('streams events for the parsed sessionRef and passes HRC watch filters', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const hrcClient = createHrcClientDouble((options) => {
      calls.push(options)
      return (async function* () {
        const events = [
          createLifecycleEvent({ hrcSeq: 41, runId: 'hrc-run-001' }),
          createLifecycleEvent({
            hrcSeq: 42,
            scopeRef: 'agent:larry:project:other',
            runId: 'hrc-run-002',
          }),
        ]

        for (const event of events) {
          if (event.scopeRef === options?.scopeRef && event.laneRef === options?.laneRef) {
            yield event
          }
        }
      })()
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(
          eventsRequest(
            `sessionRef=${encodeURIComponent(SESSION_REF)}&follow=false&fromSeq=41&runId=hrc-run-001&generation=2`
          )
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('application/x-ndjson')
        expect(response.headers.get('x-acp-session-ref')).toBe(SESSION_REF)
        const events = parseNdjson(await response.text())
        expect(events).toHaveLength(1)
        expect(events[0]?.scopeRef).toBe(SCOPE_REF)
        expect(calls[0]).toEqual(
          expect.objectContaining({
            scopeRef: SCOPE_REF,
            laneRef: 'main',
            follow: false,
            fromSeq: 41,
            runId: 'hrc-run-001',
            generation: 2,
            signal: expect.any(AbortSignal),
          })
        )
      },
      { hrcClient }
    )
  })

  test('supports scopeRef-only project sessions with main lane', async () => {
    const hrcClient = createHrcClientDouble((options) =>
      (async function* () {
        yield createLifecycleEvent({
          scopeRef: options?.scopeRef,
          laneRef: options?.laneRef,
        } as Partial<HrcLifecycleEvent>)
      })()
    )

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(
          eventsRequest(
            `sessionRef=${encodeURIComponent('agent:larry:project:agent-spaces/lane:main')}`
          )
        )

        expect(response.status).toBe(200)
        const events = parseNdjson(await response.text())
        expect(events[0]).toMatchObject({ scopeRef: SCOPE_REF, laneRef: 'main' })
      },
      { hrcClient }
    )
  })

  test('rejects malformed sessionRef values with field details', async () => {
    const hrcClient = createHrcClientDouble(async function* () {})
    const invalid = [
      '',
      'agent:larry:project:agent-spaces',
      'agent:larry:project:agent-spaces/main',
      '/lane:main',
      'agent:larry:project:agent-spaces/lane:',
    ]

    await withWiredServer(
      async (fixture) => {
        for (const value of invalid) {
          const response = await fixture.request(
            eventsRequest(`sessionRef=${encodeURIComponent(value)}`)
          )
          expect(response.status).toBe(400)
          const body = (await response.json()) as {
            error: { details?: { field?: string | undefined } | undefined }
          }
          expect(body.error.details?.field).toBe('sessionRef')
        }
      },
      { hrcClient }
    )
  })

  test('rejects fromSeq below one', async () => {
    const hrcClient = createHrcClientDouble(async function* () {})
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(
          eventsRequest(`sessionRef=${encodeURIComponent(SESSION_REF)}&fromSeq=0`)
        )
        expect(response.status).toBe(400)
        const body = (await response.json()) as {
          error: { details?: { field?: string | undefined } | undefined }
        }
        expect(body.error.details?.field).toBe('fromSeq')
      },
      { hrcClient }
    )
  })

  test('aborts HRC watch when the client cancels the stream', async () => {
    let watchSignal: AbortSignal | undefined
    let returned = false
    const hrcClient = createHrcClientDouble((options) => {
      watchSignal = options?.signal
      return (async function* () {
        try {
          yield createLifecycleEvent()
          await new Promise<void>((resolve) => {
            watchSignal?.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          returned = true
        }
      })()
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(
          eventsRequest(`sessionRef=${encodeURIComponent(SESSION_REF)}`)
        )
        const reader = response.body?.getReader()
        expect(reader).toBeDefined()

        const first = await reader?.read()
        expect(first?.done).toBe(false)

        await reader?.cancel()
        await Bun.sleep(0)

        expect(watchSignal?.aborted).toBe(true)
        expect(returned).toBe(true)
      },
      { hrcClient }
    )
  })
})
