import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin agents endpoints', () => {
  test('POST /v1/admin/agents creates and GET endpoints read back agents', async () => {
    await withWiredServer(async (fixture) => {
      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'smokey',
          displayName: 'Smokey',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(createResponse.status).toBe(201)
      expect(
        await fixture.json<{ agent: { agentId: string; status: string } }>(createResponse)
      ).toEqual({
        agent: expect.objectContaining({ agentId: 'smokey', status: 'active' }),
      })

      const listResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents',
      })

      expect(listResponse.status).toBe(200)
      expect(await fixture.json<{ agents: Array<{ agentId: string }> }>(listResponse)).toEqual({
        agents: [expect.objectContaining({ agentId: 'smokey' })],
      })

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/smokey',
      })

      expect(getResponse.status).toBe(200)
      expect(await fixture.json<{ agent: { agentId: string } }>(getResponse)).toEqual({
        agent: expect.objectContaining({ agentId: 'smokey' }),
      })
    })
  })

  test('POST duplicate returns 409 and PATCH validates status values', async () => {
    await withWiredServer(async (fixture) => {
      const created = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'larry',
          displayName: 'Larry',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(created.status).toBe(201)

      const duplicate = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'larry',
          displayName: 'Larry Duplicate',
          status: 'active',
          actor: { kind: 'agent', id: 'operator' },
        },
      })

      expect(duplicate.status).toBe(409)
      expect(await fixture.json<{ error: { code: string } }>(duplicate)).toEqual({
        error: expect.objectContaining({ code: 'idempotency_conflict' }),
      })

      const invalidPatch = await fixture.request({
        method: 'PATCH',
        path: '/v1/admin/agents/larry',
        body: {
          status: 'retired',
          actor: { kind: 'human', id: 'operator' },
        },
      })

      expect(invalidPatch.status).toBe(400)
      expect(await fixture.json<{ error: { code: string } }>(invalidPatch)).toEqual({
        error: expect.objectContaining({ code: 'malformed_request' }),
      })
    })
  })
})
