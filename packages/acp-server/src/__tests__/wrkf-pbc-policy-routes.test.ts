import { describe, expect, test } from 'bun:test'

import {
  ACTOR,
  IDEMPOTENCY_KEY,
  TASK,
  makeFakePbcPort,
} from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC policy HTTP contract', () => {
  test.each([
    {
      name: 'inspect',
      method: 'GET' as const,
      path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
      body: undefined,
    },
    {
      name: 'run-step',
      method: 'POST' as const,
      path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
      body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
    },
    {
      name: 'approve-transition',
      method: 'POST' as const,
      path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
      body: {
        transition: 'complete_implementation',
        actor: ACTOR,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    },
    {
      name: 'run-until-blocked',
      method: 'POST' as const,
      path: `/v1/wrkf/pbc/tasks/${TASK}/run-until-blocked`,
      body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
    },
    {
      name: 'deliver-effects',
      method: 'POST' as const,
      path: '/v1/wrkf/effects/deliver',
      body: { task: TASK },
    },
  ])('$name without wrkf returns 503 WRKF_UNAVAILABLE', async ({ method, path, body }) => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method,
        path,
        ...(body !== undefined ? { body } : {}),
      })
      expect(response.status).toBe(503)
      const result = await fixture.json<{ error: { code: string } }>(response)
      expect(result.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })

  test('GET /v1/wrkf/pbc/tasks/:task/inspect responds 403 when authorize returns deny', async () => {
    const wrkf = makeFakePbcPort()
    const authzCalls: Array<{ operation: string; resource: unknown }> = []

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).toBe(403)
        expect(wrkf._calls).toHaveLength(0)
      },
      {
        wrkf,
        authorize: (_actor, operation, resource) => {
          authzCalls.push({ operation, resource })
          return 'deny'
        },
      }
    )

    expect(authzCalls).toEqual([
      {
        operation: 'wrkf.pbc.inspect',
        resource: { kind: 'wrkf-task', id: TASK },
      },
    ])
  })

  test('GET /v1/wrkf/pbc/tasks/:task/inspect passes through when authorize returns allow', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(TASK)
      },
      {
        wrkf,
        authorize: () => 'allow',
      }
    )
  })
})
