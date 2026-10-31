// PBC product facade: effects. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import { TASK, makeProductFakePort } from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('POST /v1/pbc/tasks/:taskId/effects/reconcile — operator route (RED)', () => {
  test('[RED] returns 200 with reconcile result', async () => {
    const wrkf = makeProductFakePort({
      effectList: async () => [{ id: 'eff-001', kind: 'set_task_state', status: 'pending' }],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
          body: {},
        })
        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
        body: {},
      })
      expect(response.status).toBe(503)
    })
  })
})
