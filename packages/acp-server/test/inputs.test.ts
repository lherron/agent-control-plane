import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/inputs and GET /v1/runs/:runId', () => {
  test('creates an input attempt and a run', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-1',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60001:role:implementer',
            laneRef: 'main',
          },
          content: 'run the repro',
          actor: { agentId: 'tracy' },
          meta: { source: 'cli' },
        },
      })
      const payload = await fixture.json<{ inputAttempt: { taskId?: string } }>(response)

      expect(response.status).toBe(201)
      expect(payload.inputAttempt.taskId).toBe('T-60001')
      expect(fixture.runStore.listRuns()).toHaveLength(1)
    })
  })

  test('deduplicates identical idempotency keys', async () => {
    await withWiredServer(async (fixture) => {
      const body = {
        idempotencyKey: 'input-2',
        sessionRef: {
          scopeRef: 'agent:larry:project:demo:task:T-60002:role:implementer',
          laneRef: 'main',
        },
        content: 'repeatable input',
        actor: { agentId: 'tracy' },
      }

      const first = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const second = await fixture.request({ method: 'POST', path: '/v1/inputs', body })
      const firstPayload = await fixture.json<{ inputAttempt: { inputAttemptId: string } }>(first)
      const secondPayload = await fixture.json<{ inputAttempt: { inputAttemptId: string } }>(second)

      expect(firstPayload.inputAttempt.inputAttemptId).toBe(
        secondPayload.inputAttempt.inputAttemptId
      )
      expect(fixture.runStore.listRuns()).toHaveLength(1)
    })
  })

  test('returns 409 for different bodies using the same idempotency key', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-3',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60003:role:implementer',
            laneRef: 'main',
          },
          content: 'first body',
          actor: { agentId: 'tracy' },
        },
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          idempotencyKey: 'input-3',
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60003:role:implementer',
            laneRef: 'main',
          },
          content: 'second body',
          actor: { agentId: 'tracy' },
        },
      })

      expect(response.status).toBe(409)
    })
  })

  test('returns stored runs by runId', async () => {
    await withWiredServer(async (fixture) => {
      await fixture.request({
        method: 'POST',
        path: '/v1/inputs',
        body: {
          sessionRef: {
            scopeRef: 'agent:larry:project:demo:task:T-60004:role:implementer',
            laneRef: 'main',
          },
          content: 'inspect run',
          actor: { agentId: 'tracy' },
        },
      })
      const runId = fixture.runStore.listRuns()[0]?.runId

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/runs/${runId}`,
      })
      const payload = await fixture.json<{ run: { runId: string; status: string } }>(response)

      expect(response.status).toBe(200)
      expect(payload.run.runId).toBe(runId)
      expect(payload.run.status).toBe('pending')
    })
  })
})
