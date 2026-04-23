import { describe, expect, test } from 'bun:test'

import { listEvents } from 'coordination-substrate'

import { appendRawCoordinationMessage } from '../src/coordination/raw-append.js'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/messages rename migration', () => {
  test('returns 410 route_moved for the new high-level shape and points callers to /v1/coordination/messages', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'clod' },
          to: { kind: 'agent', agentId: 'curly' },
          body: 'wrong route',
        },
      })

      expect(response.status).toBe(410)
      expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
        error: {
          code: 'route_moved',
          message: 'POST /v1/messages moved to /v1/coordination/messages',
        },
      })
    })
  })

  test('returns 410 route_moved for the legacy raw-append body to fully retire the public /v1/messages surface', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/messages',
        body: {
          projectId: fixture.seed.projectId,
          event: {
            ts: '2026-04-23T04:00:00.000Z',
            kind: 'message.posted',
            content: { kind: 'text', body: 'legacy append body' },
          },
        },
      })

      expect(response.status).toBe(410)
      expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
        error: {
          code: 'route_moved',
          message: 'POST /v1/messages moved to /v1/coordination/messages',
        },
      })
    })
  })

  test('keeps the raw append helper importable for non-HTTP callers', async () => {
    await withWiredServer(async (fixture) => {
      const appended = appendRawCoordinationMessage(fixture.coordStore, {
        projectId: fixture.seed.projectId,
        event: {
          ts: '2026-04-23T04:30:00.000Z',
          kind: 'message.posted',
          content: { kind: 'text', body: 'helper call' },
        },
      })

      expect(appended.event.eventId).toBeTruthy()
      expect(listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })).toHaveLength(1)
    })
  })
})
