import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/sessions/resolve', () => {
  test('delegates to sessionResolver when provided', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:demo:task:T-90001:role:implementer',
              laneRef: 'main',
            },
          },
        })
        const payload = await fixture.json<{ sessionId: string }>(response)

        expect(response.status).toBe(200)
        expect(payload.sessionId).toBe('session-123')
      },
      {
        sessionResolver: async () => 'session-123',
      }
    )
  })

  test('returns 404 when the resolver reports no session', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/sessions/resolve',
          body: {
            sessionRef: {
              scopeRef: 'agent:larry:project:demo:task:T-90002:role:implementer',
              laneRef: 'main',
            },
          },
        })

        expect(response.status).toBe(404)
      },
      {
        sessionResolver: async () => undefined,
      }
    )
  })

  test('returns 404 when no resolver is wired', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/sessions/resolve',
        body: {
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-90003:role:implementer',
            laneRef: 'main',
          },
        },
      })

      expect(response.status).toBe(404)
    })
  })
})
