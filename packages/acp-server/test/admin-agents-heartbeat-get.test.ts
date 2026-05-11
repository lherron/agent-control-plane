import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin agent heartbeat detail endpoint', () => {
  test('GET /v1/admin/agents/:agentId/heartbeat reads heartbeat state', async () => {
    await withWiredServer(async (fixture) => {
      const created = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'larry',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })
      expect(created.status).toBe(201)

      const empty = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/larry/heartbeat',
      })
      expect(empty.status).toBe(200)
      expect(await fixture.json<{ heartbeat: unknown }>(empty)).toEqual({ heartbeat: null })

      const upserted = await fixture.request({
        method: 'PUT',
        path: '/v1/admin/agents/larry/heartbeat',
        body: {
          source: 'test',
          note: 'available',
          scopeRef: 'agent:larry:project:agent-spaces',
          laneRef: 'main',
        },
      })
      expect(upserted.status).toBe(200)

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/larry/heartbeat',
      })
      expect(response.status).toBe(200)
      expect(
        await fixture.json<{
          heartbeat: {
            agentId: string
            source: string
            lastNote: string
            targetScopeRef: string
            targetLaneRef: string
          }
        }>(response)
      ).toEqual({
        heartbeat: expect.objectContaining({
          agentId: 'larry',
          source: 'test',
          lastNote: 'available',
          targetScopeRef: 'agent:larry:project:agent-spaces',
          targetLaneRef: 'main',
        }),
      })

      const missing = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/ghost/heartbeat',
      })
      expect(missing.status).toBe(404)
    })
  })
})
