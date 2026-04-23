import { describe, expect, test } from 'bun:test'

import { listEvents } from 'coordination-substrate'

import { withWiredServer } from './fixtures/wired-server.js'

describe('actor-stamp: coordination messages', () => {
  test('prefers X-ACP-Actor over message body semantics when appending a coordination event', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        headers: { 'x-acp-actor': 'agent:curly' },
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'larry' },
          to: {
            kind: 'sessionRef',
            sessionRef: {
              scopeRef: `agent:moe:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
          },
          body: 'Header actor should stamp the coordination event.',
        },
      })

      expect(response.status).toBe(201)
      const [event] = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })
      expect(event?.actor).toEqual({ kind: 'agent', agentId: 'curly' })
    })
  })

  test('falls back to the body actor when appending a coordination event', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'larry' },
          to: {
            kind: 'sessionRef',
            sessionRef: {
              scopeRef: `agent:moe:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
          },
          body: 'Body actor should stamp the coordination event.',
        },
      })

      expect(response.status).toBe(201)
      const [event] = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })
      expect(event?.actor).toEqual({ kind: 'human', id: 'body-operator' })
    })
  })

  test('falls back to the default system actor when appending a coordination event without an actor', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/coordination/messages',
        body: {
          projectId: fixture.seed.projectId,
          from: { kind: 'agent', agentId: 'larry' },
          to: {
            kind: 'sessionRef',
            sessionRef: {
              scopeRef: `agent:moe:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
          },
          body: 'Default actor should stamp the coordination event.',
        },
      })

      expect(response.status).toBe(201)
      const [event] = listEvents(fixture.coordStore, { projectId: fixture.seed.projectId })
      expect(event?.actor).toEqual({ kind: 'system', id: 'acp-local' })
    })
  })
})
