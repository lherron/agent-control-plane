// PBC product facade: routing. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  HUMAN_ACTOR,
  PBC_WORKFLOW_REF,
  TASK,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('Route registration — all /v1/pbc/* routes are registered (RED)', () => {
  test('[RED] POST /v1/pbc/tasks/:taskId/start is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'reg-check-start', intake: { title: 'test' } },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] GET /v1/pbc/tasks/:taskId is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/input is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'reg-check-input',
            kind: 'clarification_response',
            data: { answer: 'test' },
          },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/continue is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'reg-check-continue' },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/dispose is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'reg-check-dispose',
            resolution: 'abandoned',
            reason: 'test',
          },
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] GET /v1/pbc/jobs/:jobId is registered (not 404)', async () => {
    await withWiredServer(async (fixture) => {
      // Pre-seed a job so the handler can return 200, not 404-for-not-found
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '1',
        idempotencyKey: 'reg-check-job',
      })
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })
      // Registered route → non-404 (200 or 404 for not-found, but NOT route-not-found 404)
      // We test both states: if job found = 200; if not = 404 with code JOB_NOT_FOUND
      // Either way, a registered route should return non-404 for a real job
      expect(response.status).not.toBe(404)
    })
  })

  test('[RED] POST /v1/pbc/tasks/:taskId/effects/reconcile is registered (not 404)', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/effects/reconcile`,
          body: {},
        })
        expect(response.status).not.toBe(404)
      },
      { wrkf }
    )
  })

  test('[RED] mutating /pbc/* routes respond 403 when authorize returns deny', async () => {
    const wrkf = makeProductFakePort()
    const mutatingRoutes = [
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/start`,
        body: { idempotencyKey: 'authz-start', intake: { title: 'test' } },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/input`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'authz-input',
          kind: 'clarification_response',
          data: { answer: 'test' },
        },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/continue`,
        body: { idempotencyKey: 'authz-continue' },
      },
      {
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/dispose`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: { idempotencyKey: 'authz-dispose', resolution: 'abandoned', reason: 'test' },
      },
    ]

    await withWiredServer(
      async (fixture) => {
        for (const route of mutatingRoutes) {
          const response = await fixture.request(route)
          // With authorize → 'deny', mutating routes must return 403
          // RED: all return 404 (not registered); should be 403 once registered with authz wrapper
          expect(response.status).toBe(403)
        }
      },
      {
        wrkf,
        authorize: () => 'deny',
      }
    )
  })

  test('[RED] GET /v1/pbc/tasks/:taskId is NOT wrapped with authz (read-only)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        // Read-only route: authorize=deny must not block it

        expect(response.status).toBe(200)
      },
      {
        wrkf,
        authorize: () => 'deny',
      }
    )
  })
})
