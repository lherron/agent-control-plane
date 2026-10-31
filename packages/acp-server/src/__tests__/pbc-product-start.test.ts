// PBC product facade: start. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  CLARIFICATION_NEXT,
  IDEMPOTENCY_KEY,
  PBC_WORKFLOW_REF,
  TASK,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('POST /v1/pbc/tasks/:taskId/start — basic contract (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection + job on fresh start', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: IDEMPOTENCY_KEY,
            intake: { title: 'Fix the login button' },
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // PbcTaskProjection fields
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(body['screen']).toBeDefined()
        expect(body['diagnostics']).toBeDefined()
        const diagnostics = body['diagnostics'] as Record<string, unknown>
        expect(diagnostics['pack']).toBe('pbc')

        // Job is returned
        expect(body['activeJob']).toBeDefined()
        const job = body['activeJob'] as Record<string, unknown>
        expect(job['id']).toBeDefined()
        expect(typeof job['status']).toBe('string')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/start`,
        body: { idempotencyKey: IDEMPOTENCY_KEY, intake: { title: 'test' } },
      })

      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })

  test('[RED] returns 400 when idempotencyKey is absent', async () => {
    const wrkf = makeProductFakePort()
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { intake: { title: 'test' } }, // missing idempotencyKey
        })

        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] start creates a PBC continuation job record in stateStore', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'start-job-create-test', intake: { title: 'test' } },
        })

        expect(response.status).toBe(200)

        // A job record must be persisted in stateStore
        const allJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const taskJobs = allJobs.filter((j) => j.taskId === TASK)
        expect(taskJobs.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })

  test('[RED] start does NOT create job when instance is waiting for human input', async () => {
    // If the instance is already waiting (human gate), no new job should be admitted
    const wrkf = makeProductFakePort({
      taskInspect: async () => ({
        task: { taskId: TASK },
        instance: {
          id: 'inst-pbc-002',
          workflowRef: PBC_WORKFLOW_REF,
          state: { status: 'waiting', phase: 'clarification' },
          revision: 3,
        },
      }),
      next: async () => CLARIFICATION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: { idempotencyKey: 'start-no-job-waiting', intake: { title: 'test' } },
        })

        expect(response.status).toBe(200)

        // No job admitted: waiting status = human gate
        const allQueued = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const taskJobs = allQueued.filter((j) => j.taskId === TASK)
        expect(taskJobs).toHaveLength(0)
      },
      { wrkf }
    )
  })
})

describe('POST /v1/pbc/tasks/:taskId/start — durable idempotency (RED)', () => {
  test('[RED] same idempotencyKey + same body → replay (no duplicate wrkf calls)', async () => {
    const wrkf = makeProductFakePort()

    const body = {
      idempotencyKey: 'start-idem-replay-001',
      intake: { title: 'Fix login button (idempotency test)' },
    }

    await withWiredServer(
      async (fixture) => {
        // First call: fresh
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)

        const callsAfterFirst = wrkf._calls.length

        // Second call: same key + same body → replay
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })

        expect(second.status).toBe(200)

        // On replay, no new wrkf calls (evidence.add, task.attach, etc.)
        expect(wrkf._calls.length).toBe(callsAfterFirst)
      },
      { wrkf }
    )
  })

  test('[RED] same idempotencyKey + same body → replay returns same response shape', async () => {
    const wrkf = makeProductFakePort()

    const body = {
      idempotencyKey: 'start-idem-shape-001',
      intake: { title: 'Fix login button (shape test)' },
    }

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)
        const firstBody = await fixture.json<Record<string, unknown>>(first)

        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(second.status).toBe(200)
        const secondBody = await fixture.json<Record<string, unknown>>(second)

        // Both responses have same shape
        expect(secondBody['taskId']).toBe(firstBody['taskId'])
        expect(secondBody['source']).toBe(firstBody['source'])
        expect(secondBody['workflowRef']).toBe(firstBody['workflowRef'])
      },
      { wrkf }
    )
  })

  test('[RED] same idempotencyKey + DIFFERENT body → 409 IDEMPOTENCY_MISMATCH', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        // First call with one body
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'start-idem-conflict-001',
            intake: { title: 'Fix login button — original' },
          },
        })
        expect(first.status).toBe(200)

        // Second call — SAME key, DIFFERENT body
        const conflict = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'start-idem-conflict-001', // same key
            intake: { title: 'Fix login button — DIFFERENT' }, // different body
          },
        })

        expect(conflict.status).toBe(409)
        const conflictBody = await fixture.json<{ error: { code: string } }>(conflict)
        expect(conflictBody.error.code).toBe('IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('[RED] evidence.add not re-called on replay (intake_metadata idempotency)', async () => {
    const wrkf = makeProductFakePort()
    const body = {
      idempotencyKey: 'start-no-dup-evidence-001',
      intake: { title: 'No duplicate evidence test' },
    }

    await withWiredServer(
      async (fixture) => {
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(first.status).toBe(200)

        const evidenceAddCountAfterFirst = wrkf._calls.filter(
          (c) => c.method === 'evidence.add'
        ).length

        // Replay: no new evidence.add
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body,
        })
        expect(second.status).toBe(200)

        const evidenceAddCountAfterSecond = wrkf._calls.filter(
          (c) => c.method === 'evidence.add'
        ).length
        expect(evidenceAddCountAfterSecond).toBe(evidenceAddCountAfterFirst)
      },
      { wrkf }
    )
  })
})

describe('contextHash is diagnostics-only — NOT a required mutation input (RED)', () => {
  test('[RED] start: body WITHOUT contextHash still returns 200 (not required)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/start`,
          body: {
            idempotencyKey: 'no-context-hash-start',
            intake: { title: 'test' },
            // NO contextHash in body
          },
        })

        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })
})
