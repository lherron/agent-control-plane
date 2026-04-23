import { withWiredServer } from './fixtures/wired-server.js'

describe('P1 scaffold routes', () => {
  test('POST /v1/admin/agents creates an agent', async () => {
    await withWiredServer(async ({ json, request }) => {
      const response = await request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'agent-123',
          displayName: 'Agent 123',
          status: 'active',
        },
      })

      expect(response.status).toBe(201)
      expect(await json<{ agent: { agentId: string } }>(response)).toMatchObject({
        agent: { agentId: 'agent-123' },
      })
    })
  })

  test('GET /v1/admin/agents/:agentId returns the persisted agent', async () => {
    await withWiredServer(async ({ json, request }) => {
      await request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'agent-123',
          displayName: 'Agent 123',
          status: 'active',
        },
      })

      const response = await request({
        method: 'GET',
        path: '/v1/admin/agents/agent-123',
      })

      expect(response.status).toBe(200)
      expect(await json<{ agent: { agentId: string } }>(response)).toMatchObject({
        agent: { agentId: 'agent-123' },
      })
    })
  })

  test('GET /v1/gateway/deliveries?status=failed returns an empty failed-delivery page', async () => {
    await withWiredServer(async ({ json, request }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/gateway/deliveries?status=failed',
      })

      expect(response.status).toBe(200)
      expect(
        await json<{
          deliveries: unknown[]
          nextCursor: string | null
        }>(response)
      ).toEqual({
        deliveries: [],
        nextCursor: null,
      })
    })
  })
})
