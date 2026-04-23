import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

function readActor(record: Record<string, unknown>): unknown {
  return record['actor']
}

describe('actor-stamp: input attempts', () => {
  test('prefers X-ACP-Actor over body actor when creating an input attempt', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        headers: { 'x-acp-actor': 'agent:curly' },
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Run the actor stamp test.',
        },
      })

      expect(response.status).toBe(201)
      const payload = await fixture.json<{ inputAttempt: Record<string, unknown> }>(response)
      expect(readActor(payload.inputAttempt)).toEqual({ kind: 'agent', id: 'curly' })
    })
  })

  test('falls back to the body actor when the header is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          actor: { kind: 'human', id: 'body-operator' },
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Body actor should stamp the attempt.',
        },
      })

      expect(response.status).toBe(201)
      const payload = await fixture.json<{ inputAttempt: Record<string, unknown> }>(response)
      expect(readActor(payload.inputAttempt)).toEqual({ kind: 'human', id: 'body-operator' })
    })
  })

  test('falls back to the default system actor when no request actor is supplied', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          content: 'Env default should stamp the attempt.',
        },
      })

      expect(response.status).toBe(201)
      const payload = await fixture.json<{ inputAttempt: Record<string, unknown> }>(response)
      expect(readActor(payload.inputAttempt)).toEqual({ kind: 'system', id: 'acp-local' })
    })
  })
})
