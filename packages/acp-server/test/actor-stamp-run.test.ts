import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

function readActor(record: Record<string, unknown>): unknown {
  return record['actor']
}

async function createRunViaInputs(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never,
  input: { headers?: HeadersInit | undefined; body?: Record<string, unknown> | undefined }
): Promise<{ runId?: string | undefined; response: Response }> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/inputs',
    headers: input.headers,
    body: {
      sessionRef: {
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
      },
      content: 'Create a run with actor stamping.',
      ...(input.body ?? {}),
    },
  })

  if (!response.ok) {
    return { response }
  }

  const payload = await fixture.json<{ run: { runId: string } }>(response)
  return { runId: payload.run.runId, response }
}

describe('actor-stamp: runs', () => {
  test('prefers X-ACP-Actor over body actor when creating a run through /v1/inputs', async () => {
    await withWiredServer(async (fixture) => {
      const created = await createRunViaInputs(fixture, {
        headers: { 'x-acp-actor': 'agent:curly' },
        body: { actor: { kind: 'human', id: 'body-operator' } },
      })

      expect(created.response.status).toBe(201)
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${created.runId}`,
      })

      expect(response.status).toBe(200)
      const payload = await fixture.json<{ run: Record<string, unknown> }>(response)
      expect(readActor(payload.run)).toEqual({ kind: 'agent', id: 'curly' })
    })
  })

  test('falls back to the body actor when the run is created without a header', async () => {
    await withWiredServer(async (fixture) => {
      const created = await createRunViaInputs(fixture, {
        body: { actor: { kind: 'human', id: 'body-operator' } },
      })

      expect(created.response.status).toBe(201)
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${created.runId}`,
      })

      expect(response.status).toBe(200)
      const payload = await fixture.json<{ run: Record<string, unknown> }>(response)
      expect(readActor(payload.run)).toEqual({ kind: 'human', id: 'body-operator' })
    })
  })

  test('falls back to the default system actor when no request actor is supplied', async () => {
    await withWiredServer(async (fixture) => {
      const created = await createRunViaInputs(fixture, {})

      expect(created.response.status).toBe(201)
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${created.runId}`,
      })

      expect(response.status).toBe(200)
      const payload = await fixture.json<{ run: Record<string, unknown> }>(response)
      expect(readActor(payload.run)).toEqual({ kind: 'system', id: 'acp-local' })
    })
  })
})
