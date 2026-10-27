import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/messages rename migration', () => {
  test('POST /v1/messages returns 410 route_moved pointing to /v1/coordination/messages', async () => {
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
})
