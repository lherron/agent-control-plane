import { describe, expect, test } from 'bun:test'

import {
  ACTOR,
  IDEMPOTENCY_KEY,
  TASK,
  WrkfError,
  makeFakePbcPort,
} from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC approve-transition HTTP contract', () => {
  test('returns 200 with PbcHarnessResult on successful approve-transition', async () => {
    const specificTask = 'T-77777'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${specificTask}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['task']).toBe(specificTask)
        expect(body['workflowRef']).toBe('pbc-progressive-refinement@9')
        expect(body['transitionApplied']).toBeDefined()
        const wireCall = wrkf._calls.find((c) => c.method === 'transition.apply')
        expect(wireCall).toBeDefined()
        expect(wireCall!.params).toMatchObject({ task: specificTask })
        expect((wireCall!.params as Record<string, unknown>)['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('maps WRKF_TRANSITION_BLOCKED → HTTP 422', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_TRANSITION_BLOCKED', 'blockers: missing evidence')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
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
      transitionApply: async () => {
        throw new WrkfError('WRKF_ROLE_DENIED', 'role not allowed to apply this transition')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(403)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_ROLE_DENIED')
      },
      { wrkf }
    )
  })

  test('maps WRKF_IDEMPOTENCY_MISMATCH from wrkf → HTTP 409', async () => {
    // This is the WRKF-layer idempotency mismatch (distinct from ACP body-hash mismatch).
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_IDEMPOTENCY_MISMATCH', 'wrkf idempotency conflict')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'complete_implementation',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('approve-transition: WRKF_NOT_FOUND from transition.apply → 404 with code', async () => {
    const wrkf = makeFakePbcPort({
      transitionApply: async () => {
        throw new WrkfError('WRKF_NOT_FOUND', 'transition not found')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/approve-transition`,
          body: {
            transition: 'nonexistent_transition',
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
          },
        })

        expect(response.status).toBe(404)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_NOT_FOUND')
      },
      { wrkf }
    )
  })
})
