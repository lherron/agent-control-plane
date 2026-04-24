/**
 * Red tests for GET /v1/ops/session-dashboard/snapshot
 *
 * Spec reference: SESSION_DASHBOARD.md §8.1–§8.4
 *
 * These tests exercise the snapshot endpoint contract. They are intentionally
 * RED — the route is not yet wired in exact-routes.ts and no handler exists.
 * Once the handler is implemented and the route is registered, these tests
 * define the expected behavior.
 *
 * Non-goals:
 * - Does NOT test authZ (skipped for Phase 1).
 * - Does NOT implement the handler.
 * - Does NOT touch handlers/sessions-events.ts (existing per-session proxy).
 */
import { describe, expect, test } from 'bun:test'

import type { SessionDashboardSnapshot } from 'acp-ops-projection'

import { withWiredServer } from './fixtures/wired-server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = '/v1/ops/session-dashboard/snapshot'

function snapshotRequest(query = ''): { method: string; path: string } {
  const qs = query.length > 0 ? `?${query}` : ''
  return { method: 'GET', path: `${SNAPSHOT_PATH}${qs}` }
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

      // §8.1 required top-level fields
      expect(typeof body.serverTime).toBe('string')
      expect(typeof body.generatedAt).toBe('string')

      // window
      expect(body.window).toBeDefined()
      expect(typeof body.window.fromTs).toBe('string')
      expect(typeof body.window.toTs).toBe('string')

      // cursors
      expect(body.cursors).toBeDefined()
      expect(typeof body.cursors.nextFromSeq).toBe('number')

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

  // -- Default query parameters ----------------------------------------------

  test('uses default windowMs=90000 when not specified', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest())
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)

      // window range should span roughly 90s (90000ms)
      const fromTs = new Date(body.window.fromTs).getTime()
      const toTs = new Date(body.window.toTs).getTime()
      const windowMs = toTs - fromTs
      expect(windowMs).toBeGreaterThanOrEqual(89_000)
      expect(windowMs).toBeLessThanOrEqual(91_000)
    })
  })

  test('uses default limitSessions=50 and limitEvents=5000', async () => {
    await withWiredServer(async (fixture) => {
      // With no events we can't test truncation, but verify the endpoint
      // accepts the call without explicit limits and responds OK.
      const response = await fixture.request(snapshotRequest())
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(body.sessions.length).toBeLessThanOrEqual(50)
      expect(body.events.length).toBeLessThanOrEqual(5000)
    })
  })

  test('uses default includePrior=false', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest())
      expect(response.status).toBe(200)

      // Default excludes prior sessions; with empty state this is just a sanity check
      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(Array.isArray(body.sessions)).toBe(true)
    })
  })

  // -- Custom query parameters -----------------------------------------------

  test('accepts windowMs override', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('windowMs=30000'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      const fromTs = new Date(body.window.fromTs).getTime()
      const toTs = new Date(body.window.toTs).getTime()
      const windowMs = toTs - fromTs
      expect(windowMs).toBeGreaterThanOrEqual(29_000)
      expect(windowMs).toBeLessThanOrEqual(31_000)
    })
  })

  test('accepts limitSessions override', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('limitSessions=5'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(body.sessions.length).toBeLessThanOrEqual(5)
    })
  })

  test('accepts limitEvents override', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('limitEvents=10'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(body.events.length).toBeLessThanOrEqual(10)
    })
  })

  test('accepts includePrior=true', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('includePrior=true'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(Array.isArray(body.sessions)).toBe(true)
    })
  })

  // -- Filtering by scopeRef, laneRef, projectId ----------------------------

  test('filters snapshot by scopeRef', async () => {
    await withWiredServer(async (fixture) => {
      const scope = encodeURIComponent('agent:curly:project:agent-spaces:task:T-01200:role:tester')
      const response = await fixture.request(snapshotRequest(`scopeRef=${scope}`))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      // All returned sessions must match the requested scopeRef
      for (const row of body.sessions) {
        expect(row.sessionRef.scopeRef).toBe(
          'agent:curly:project:agent-spaces:task:T-01200:role:tester'
        )
      }
    })
  })

  test('filters snapshot by laneRef', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('laneRef=repair'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      for (const row of body.sessions) {
        expect(row.sessionRef.laneRef).toBe('repair')
      }
    })
  })

  test('filters snapshot by projectId', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('projectId=agent-spaces'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      // projectId filtering is applied; empty result is valid for empty state
      expect(Array.isArray(body.sessions)).toBe(true)
    })
  })

  test('filters snapshot by status=active', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest('status=active'))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(Array.isArray(body.sessions)).toBe(true)
    })
  })

  // -- Combined filters ------------------------------------------------------

  test('combines scopeRef and laneRef filters', async () => {
    await withWiredServer(async (fixture) => {
      const scope = encodeURIComponent('agent:curly:project:agent-spaces:task:T-01200:role:tester')
      const response = await fixture.request(snapshotRequest(`scopeRef=${scope}&laneRef=main`))
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      for (const row of body.sessions) {
        expect(row.sessionRef.scopeRef).toBe(
          'agent:curly:project:agent-spaces:task:T-01200:role:tester'
        )
        expect(row.sessionRef.laneRef).toBe('main')
      }
    })
  })

  // -- Response schema consistency -------------------------------------------

  test('serverTime and generatedAt are ISO-8601 strings', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest())
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)

      // Verify ISO-8601 parsability
      expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false)
      expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false)
    })
  })

  test('cursors.nextFromSeq is a non-negative integer', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request(snapshotRequest())
      expect(response.status).toBe(200)

      const body = await fixture.json<SessionDashboardSnapshot>(response)
      expect(Number.isInteger(body.cursors.nextFromSeq)).toBe(true)
      expect(body.cursors.nextFromSeq).toBeGreaterThanOrEqual(0)
    })
  })
})
