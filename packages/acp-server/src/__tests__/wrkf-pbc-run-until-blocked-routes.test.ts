import { describe, expect, test } from 'bun:test'

import { ACTOR, IDEMPOTENCY_KEY, makeFakePbcPort } from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC run-until-blocked HTTP contract', () => {
  test('returns 200 with PbcHarnessResult.stopReason on completion', async () => {
    // Make next return closed so the autopilot stops immediately.
    const specificTask = 'T-33333'
    const wrkf = makeFakePbcPort({
      next: async () => ({
        instance: {
          state: { status: 'closed', phase: 'done' },
          revision: 9,
          contextHash: 'ctx-closed',
        },
        actions: [],
        blockedTransitions: [],
        openObligations: [],
        pendingEffects: [],
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${specificTask}/run-until-blocked`,
          body: {
            actor: ACTOR,
            idempotencyKey: IDEMPOTENCY_KEY,
            maxTurns: 1,
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<{ stopReason: string; task: string }>(response)
        expect(body.stopReason).toBe('closed')
        expect(body.task).toBe(specificTask)
        const wireCall = wrkf._calls.find((c) => c.method === 'next')
        expect(wireCall).toBeDefined()
        expect(wireCall!.params).toMatchObject({ task: specificTask })
        expect((wireCall!.params as Record<string, unknown>)['taskId']).toBeUndefined()
      },
      { wrkf }
    )
  })
})
