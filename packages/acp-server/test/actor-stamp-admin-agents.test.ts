import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

function readCreatedBy(record: Record<string, unknown>): unknown {
  return record['createdBy']
}

const ACTOR_ROWS = [
  {
    name: 'header beats body',
    headers: { 'x-acp-actor': 'agent:curly' },
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'agent', id: 'curly' },
  },
  {
    name: 'body without header',
    headers: undefined,
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'human', id: 'body-operator' },
  },
  {
    name: 'neither falls back to the default system actor',
    headers: undefined,
    bodyActor: undefined,
    expected: { kind: 'system', id: 'acp-local' },
  },
] as const

describe('actor-stamp: admin agents', () => {
  test('prefers X-ACP-Actor over body actor when creating an admin agent', async () => {
    for (const row of ACTOR_ROWS) {
      await withWiredServer(async (fixture) => {
        const createResponse = await fixture.request({
          method: 'POST',
          path: '/v1/admin/agents',
          headers: row.headers,
          body: {
            agentId: 'smokey',
            displayName: 'Smokey',
            status: 'active',
            ...(row.bodyActor !== undefined ? { actor: row.bodyActor } : {}),
          },
        })

        expect(createResponse.status, row.name).toBe(201)
        const created = await fixture.json<{ agent: Record<string, unknown> }>(createResponse)
        expect(readCreatedBy(created.agent), row.name).toEqual(row.expected)

        const getResponse = await fixture.request({
          method: 'GET',
          path: '/v1/admin/agents/smokey',
        })
        expect(getResponse.status, row.name).toBe(200)

        const fetched = await fixture.json<{ agent: Record<string, unknown> }>(getResponse)
        expect(readCreatedBy(fetched.agent), row.name).toEqual(row.expected)
      })
    }
  })
})
