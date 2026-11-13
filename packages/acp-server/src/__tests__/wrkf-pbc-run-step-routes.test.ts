import { describe, expect, test } from 'bun:test'

import {
  ACTOR,
  IDEMPOTENCY_KEY,
  TASK,
  WrkfError,
  makeFakePbcPort,
} from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC run-step HTTP contract', () => {
  test('returns 200 with PbcHarnessResult on successful run-step', async () => {
    const specificTask = 'T-55555'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${specificTask}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            participantOutput: {
              evidence: [{ kind: 'result', summary: 'implementation done' }],
            },
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(specificTask)
        expect(body['workflowRef']).toBe('pbc-progressive-refinement@9')
        expect(body['instance']).toBeDefined()
        expect(body['next']).toBeDefined()
        const wireCall = wrkf._calls.find((c) => c.method === 'run.start')
        expect(wireCall).toBeDefined()
        expect(wireCall!.params).toMatchObject({ task: specificTask })
        expect((wireCall!.params as Record<string, unknown>)['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('run-step returns 400 when idempotencyKey is absent from body', async () => {
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR }, // missing idempotencyKey
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: { code: 'malformed_request', details: { field: 'idempotencyKey' } },
        })
        expect(wrkf._calls).toEqual([])
      },
      { wrkf }
    )
  })

  test('maps WRKF_TRANSITION_BLOCKED → HTTP 422', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_TRANSITION_BLOCKED', 'evidence requirements not met')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        expect(response.status).toBe(422)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_TRANSITION_BLOCKED')
      },
      { wrkf }
    )
  })

  test('maps WRKF_ROLE_DENIED → HTTP 403', async () => {
    const wrkf = makeFakePbcPort({
      runStart: async () => {
        throw new WrkfError('WRKF_ROLE_DENIED', 'role not permitted for this task')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })

        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_ROLE_DENIED')
      },
      { wrkf }
    )
  })

  test('maps WRKF_STALE_REVISION → HTTP 409', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_STALE_REVISION', 'revision out of date')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })

  test('maps WRKF_CONTEXT_MISMATCH → HTTP 409', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_CONTEXT_MISMATCH', 'context hash mismatch')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            transitionPolicy: 'single-safe',
          },
        })

        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })

  test('run-step: unknown wrkf error code → 500 (safe default)', async () => {
    const wrkf = makeFakePbcPort({
      runStart: async () => {
        throw new WrkfError('WRKF_SOME_FUTURE_CODE', 'future error')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: { actor: ACTOR, idempotencyKey: IDEMPOTENCY_KEY },
        })

        expect(response.status).toBe(500)
      },
      { wrkf }
    )
  })
})
