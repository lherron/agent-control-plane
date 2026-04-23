import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

function readCreatedBy(record: Record<string, unknown>): unknown {
  return record['createdBy']
}

describe('actor-stamp: admin agents', () => {
  test('prefers X-ACP-Actor over body actor when creating an admin agent', async () => {
    await withWiredServer(async (fixture) => {
      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        headers: { 'x-acp-actor': 'agent:curly' },
        body: {
          agentId: 'smokey',
          displayName: 'Smokey',
          status: 'active',
          actor: { kind: 'human', id: 'body-operator' },
        },
      })

      expect(createResponse.status).toBe(201)
      const created = await fixture.json<{ agent: Record<string, unknown> }>(createResponse)
      expect(readCreatedBy(created.agent)).toEqual({ kind: 'agent', id: 'curly' })

      const getResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/agents/smokey',
      })
      expect(getResponse.status).toBe(200)

      const fetched = await fixture.json<{ agent: Record<string, unknown> }>(getResponse)
      expect(readCreatedBy(fetched.agent)).toEqual({ kind: 'agent', id: 'curly' })
    })
  })

  test('falls back to the body actor when creating an admin agent', async () => {
    await withWiredServer(async (fixture) => {
      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'larry',
          displayName: 'Larry',
          status: 'active',
          actor: { kind: 'human', id: 'body-operator' },
        },
      })

      expect(createResponse.status).toBe(201)
      const created = await fixture.json<{ agent: Record<string, unknown> }>(createResponse)
      expect(readCreatedBy(created.agent)).toEqual({ kind: 'human', id: 'body-operator' })
    })
  })

  test('falls back to the default system actor when creating an admin agent without an actor', async () => {
    await withWiredServer(async (fixture) => {
      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/admin/agents',
        body: {
          agentId: 'moe',
          displayName: 'Moe',
          status: 'active',
        },
      })

      expect(createResponse.status).toBe(201)
      const created = await fixture.json<{ agent: Record<string, unknown> }>(createResponse)
      expect(readCreatedBy(created.agent)).toEqual({ kind: 'system', id: 'acp-local' })
    })
  })
})
