import { describe, expect, test } from 'bun:test'

import { listEvents } from 'coordination-substrate'

import { withWiredServer } from './fixtures/wired-server.js'

const ACTOR_ROWS = [
  {
    name: 'header beats body',
    headers: { 'x-acp-actor': 'agent:curly' },
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'agent', agentId: 'curly' },
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

describe('actor-stamp: coordination messages', () => {
  test('prefers X-ACP-Actor over message body semantics when appending a coordination event', async () => {
    for (const row of ACTOR_ROWS) {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/coordination/messages',
          headers: row.headers,
          body: {
            ...(row.bodyActor !== undefined ? { actor: row.bodyActor } : {}),
            projectId: fixture.seed.projectId,
            from: { kind: 'agent', agentId: 'larry' },
            to: {
              kind: 'sessionRef',
              sessionRef: {
                scopeRef: `agent:moe:project:${fixture.seed.projectId}`,
                laneRef: 'main',
              },
            },
            body: `Actor stamp row: ${row.name}.`,
          },
        })

        expect(response.status, row.name).toBe(201)
        const [event] = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })
        expect(event?.actor, row.name).toEqual(row.expected)
      })
    }
  })
})
