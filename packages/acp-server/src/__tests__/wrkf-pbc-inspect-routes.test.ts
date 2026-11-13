import { describe, expect, test } from 'bun:test'

import {
  CANNED_NEXT,
  TASK,
  WrkfError,
  makeFakePbcPort,
} from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC inspect HTTP contract', () => {
  test('returns 200 with wrkf projection on successful inspect', async () => {
    const specificTask = 'T-98765'
    const wrkf = makeFakePbcPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${specificTask}/inspect`,
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body).toEqual({
          task: specificTask,
          workflowRef: 'pbc-progressive-refinement@9',
          instance: {
            status: 'in_progress',
            phase: 'implementation',
            revision: 7,
            contextHash: 'ctx-hash-abc',
          },
          next: {
            actions: [
              {
                transition: 'complete_implementation',
                role: 'implementer',
                raw: CANNED_NEXT.actions[0],
              },
            ],
            blockedTransitions: [],
            openObligations: [],
            pendingEffects: [],
          },
        })
        expect(wrkf._calls).toEqual([
          { method: 'next', params: { task: specificTask, role: 'agent' } },
        ])
      },
      { wrkf }
    )
  })

  test('maps WRKF_NOT_FOUND → HTTP 404', async () => {
    const wrkf = makeFakePbcPort({
      next: async () => {
        throw new WrkfError('WRKF_NOT_FOUND', 'task not found')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })

        expect(response.status).toBe(404)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_NOT_FOUND')
      },
      { wrkf }
    )
  })

  test('inspect: WRKF_STALE_REVISION → 409', async () => {
    // Even inspect can hit stale revision if wrkf is in inconsistent state
    const wrkf = makeFakePbcPort({
      next: async () => {
        throw new WrkfError('WRKF_STALE_REVISION', 'inspect stale revision')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/wrkf/pbc/tasks/${TASK}/inspect`,
        })

        expect(response.status).toBe(409)
      },
      { wrkf }
    )
  })
})
