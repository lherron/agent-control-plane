/**
 * Tests for GET /v1/ops/session-dashboard/snapshot
 *
 * Spec reference: SESSION_DASHBOARD.md §8.1–§8.4
 *
 * Non-goals:
 * - Does NOT test authZ (skipped for Phase 1).
 */
import { describe, expect, test } from 'bun:test'
import { parseScopeRef } from 'agent-scope'

import type { SessionDashboardSnapshot } from 'acp-ops-projection'
import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

import type { AcpHrcClient } from '../src/index.js'
import { withWiredServer } from './fixtures/wired-server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = '/v1/ops/session-dashboard/snapshot'

function snapshotRequest(query = ''): { method: string; path: string } {
  const qs = query.length > 0 ? `?${query}` : ''
  return { method: 'GET', path: `${SNAPSHOT_PATH}${qs}` }
}

const CURLY_SCOPE = 'agent:curly:project:agent-spaces:task:T-01200:role:tester'
const LARRY_SCOPE = 'agent:larry:project:wrkq:task:T-00100:role:implementer'
const MOE_SCOPE = 'agent:moe:project:agent-spaces:task:T-01300:role:reviewer'

function sessionRecord(
  hostSessionId: string,
  overrides: Partial<HrcSessionRecord> = {}
): HrcSessionRecord {
  const scopeRef = overrides.scopeRef ?? CURLY_SCOPE
  return {
    hostSessionId,
    scopeRef,
    identity: parseScopeRef(scopeRef),
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-23T12:00:00.000Z',
    updatedAt: '2026-04-23T12:00:00.000Z',
    ...overrides,
  } as HrcSessionRecord
}

function hrcEvent(hrcSeq: number): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: new Date().toISOString(),
    hostSessionId: 'hsid-snapshot-events',
    scopeRef: CURLY_SCOPE,
    laneRef: 'main',
    generation: 1,
    category: 'session',
    eventKind: 'session.updated',
    replayed: false,
    payload: {},
  }
}

/** HRC boundary fake: answers session listing and the event log, nothing else. */
function hrcClientWith(input: {
  sessions?: HrcSessionRecord[]
  events?: HrcLifecycleEvent[]
}): AcpHrcClient {
  const events = input.events ?? []
  return {
    listLatestEventBySession: async () => events.slice(-1),
    listSessions: async () => input.sessions ?? [],
    watch: () =>
      (async function* () {
        yield* events
      })(),
  } as unknown as AcpHrcClient
}

function hostSessionIds(body: SessionDashboardSnapshot): string[] {
  return body.sessions.map((row) => row.hostSessionId).sort()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/ops/session-dashboard/snapshot', () => {
  // -- Basic response shape --------------------------------------------------

  test('returns 200 with well-typed snapshot for an empty HRC event stream', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest())

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')

      const body = await fixture.json<SessionDashboardSnapshot>(response)

      // §8.1 required top-level fields, ISO-8601 timestamps
      expect(typeof body.serverTime).toBe('string')
      expect(typeof body.generatedAt).toBe('string')
      expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false)
      expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)

      // window
      expect(body.window).toBeDefined()
      expect(typeof body.window.fromTs).toBe('string')
      expect(typeof body.window.toTs).toBe('string')

      // cursors — nothing read yet, so the next replay starts at 1
      expect(body.cursors).toBeDefined()
      expect(Number.isInteger(body.cursors.nextFromSeq)).toBe(true)
      expect(body.cursors.nextFromSeq).toBe(1)

      // summary — empty stream ⇒ all zero counts
      expect(body.summary).toBeDefined()
      const counts = body.summary.counts
      expect(counts.busy).toBe(0)
      expect(counts.idle).toBe(0)
      expect(counts.launching).toBe(0)
      expect(counts.stale).toBe(0)
      expect(counts.dead).toBe(0)
      expect(counts.inFlightInputs).toBe(0)
      expect(counts.deliveryPending).toBe(0)
      expect(body.summary.eventRatePerMinute).toBe(0)

      // empty arrays
      expect(body.sessions).toEqual([])
      expect(body.events).toEqual([])
    })
  })

  // -- Window ----------------------------------------------------------------

  test.each([
    { query: '', expectedMs: 90_000 },
    { query: 'windowMs=30000', expectedMs: 30_000 },
  ])('the window spans windowMs (default 90000): "$query"', async ({ query, expectedMs }) => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest(query))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      const windowMs = new Date(body.window.toTs).getTime() - new Date(body.window.fromTs).getTime()
      expect(windowMs).toBeGreaterThanOrEqual(expectedMs - 1_000)
      expect(windowMs).toBeLessThanOrEqual(expectedMs + 1_000)
    })
  })

  // -- Limits ----------------------------------------------------------------

  test('limitSessions truncates the session rows', async () => {
    const sessions = Array.from({ length: 6 }, (_, index) => sessionRecord(`hsid-limit-${index}`))
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(snapshotRequest('limitSessions=5'))
        expect(response.status).toBe(200)

        const body = await fixture.json<SessionDashboardSnapshot>(response)
        expect(body.sessions).toHaveLength(5)
      },
      { hrcClient: hrcClientWith({ sessions }) }
    )
  })

  test('limitEvents keeps only the newest events in the window', async () => {
    const events = Array.from({ length: 11 }, (_, index) => hrcEvent(index + 1))
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(snapshotRequest('limitEvents=10'))
        expect(response.status).toBe(200)

        const body = await fixture.json<SessionDashboardSnapshot>(response)
        expect(body.events.map((event) => event.hrcSeq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      },
      { hrcClient: hrcClientWith({ events }) }
    )
  })

  // -- includePrior ----------------------------------------------------------

  test('prior (non-active) sessions appear only with includePrior=true', async () => {
    const sessions = [
      sessionRecord('hsid-active'),
      sessionRecord('hsid-prior', { status: 'inactive' }),
    ]
    await withWiredServer(
      async (fixture) => {
        const byDefault = await fixture.json<SessionDashboardSnapshot>(
          await fixture.request(snapshotRequest())
        )
        expect(hostSessionIds(byDefault)).toEqual(['hsid-active'])

        const withPrior = await fixture.json<SessionDashboardSnapshot>(
          await fixture.request(snapshotRequest('includePrior=true'))
        )
        expect(hostSessionIds(withPrior)).toEqual(['hsid-active', 'hsid-prior'])
      },
      { hrcClient: hrcClientWith({ sessions }) }
    )
  })

  // -- Filters ---------------------------------------------------------------

  const FILTER_SESSIONS = [
    sessionRecord('hsid-curly-main'),
    sessionRecord('hsid-curly-repair', { laneRef: 'repair' }),
    sessionRecord('hsid-larry-main', { scopeRef: LARRY_SCOPE }),
    sessionRecord('hsid-moe-archived', { scopeRef: MOE_SCOPE, status: 'archived' }),
  ]

  test.each([
    {
      filter: 'scopeRef',
      query: `scopeRef=${encodeURIComponent(CURLY_SCOPE)}`,
      expected: ['hsid-curly-main', 'hsid-curly-repair'],
    },
    { filter: 'laneRef', query: 'laneRef=repair', expected: ['hsid-curly-repair'] },
    {
      filter: 'projectId',
      query: 'projectId=agent-spaces&includePrior=true',
      expected: ['hsid-curly-main', 'hsid-curly-repair', 'hsid-moe-archived'],
    },
    {
      filter: 'status=active',
      query: 'status=active&includePrior=true',
      expected: ['hsid-curly-main', 'hsid-curly-repair', 'hsid-larry-main'],
    },
    {
      filter: 'scopeRef+laneRef',
      query: `scopeRef=${encodeURIComponent(CURLY_SCOPE)}&laneRef=main`,
      expected: ['hsid-curly-main'],
    },
  ])(
    'the $filter snapshot filter keeps only matching session rows',
    async ({ query, expected }) => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request(snapshotRequest(query))
          expect(response.status).toBe(200)

          const body = await fixture.json<SessionDashboardSnapshot>(response)
          expect(hostSessionIds(body)).toEqual(expected)
        },
        { hrcClient: hrcClientWith({ sessions: FILTER_SESSIONS }) }
      )
    }
  )

  test('reads only the bounded tail of the HRC event log', async () => {
    let watchedFromSeq: number | undefined
    const latestEvent: HrcLifecycleEvent = {
      hrcSeq: 25_000,
      streamSeq: 25_000,
      ts: new Date().toISOString(),
      hostSessionId: 'hsid-bounded-snapshot',
      scopeRef: 'agent:cody:project:agent-control-plane',
      laneRef: 'main',
      generation: 1,
      category: 'session',
      eventKind: 'session.updated',
      replayed: false,
      payload: {},
    }
    const hrcClient = {
      listLatestEventBySession: async () => [latestEvent],
      listSessions: async () => [],
      watch: (options?: { fromSeq?: number }) =>
        (async function* () {
          watchedFromSeq = options?.fromSeq
          yield latestEvent
        })(),
    } as unknown as AcpHrcClient

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request(snapshotRequest())
        expect(response.status).toBe(200)
        expect(watchedFromSeq).toBe(15_001)
        const body = await fixture.json<SessionDashboardSnapshot>(response)
        expect(body.cursors.lastHrcSeq).toBe(25_000)
      },
      { hrcClient }
    )
  })
})
