// PBC product facade: continuation-jobs. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  BEHAVIOR_NOTE_NEXT,
  CLARIFICATION_NEXT,
  PBC_WORKFLOW_REF,
  TASK,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('POST /v1/pbc/tasks/:taskId/continue — durable job, NO inline HRC (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection + job', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-basic-001' },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['activeJob']).toBeDefined()
        const job = body['activeJob'] as Record<string, unknown>
        expect(job['id']).toBeDefined()
        expect(['queued', 'running']).toContain(job['status'])
      },
      { wrkf }
    )
  })

  test('[RED] /continue does NOT call run.start (no inline HRC work in HTTP handler)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-no-hrc-001' },
        })

        expect(response.status).toBe(200)

        // run.start MUST NOT be called in the HTTP handler — that's the worker's job
        const runStartCalls = wrkf._calls.filter((c) => c.method === 'run.start')
        expect(runStartCalls).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] /continue creates a job record in stateStore.pbcContinuationJobs', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-job-create-001' },
        })
        expect(response.status).toBe(200)

        // A queued (or running) job must exist in the state store
        const queuedJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('queued')
        const runningJobs = fixture.stateStore.pbcContinuationJobs.listByStatus('running')
        const allActiveJobs = [...queuedJobs, ...runningJobs].filter((j) => j.taskId === TASK)
        expect(allActiveJobs.length).toBeGreaterThan(0)
      },
      { wrkf }
    )
  })

  test('[RED] same revision → same job returned (dedup by task+revision)', async () => {
    const wrkf = makeProductFakePort({
      // Keep returning the same revision so dedup fires
      next: async () => ({
        ...BEHAVIOR_NOTE_NEXT,
        instance: { ...BEHAVIOR_NOTE_NEXT.instance, revision: 42 },
      }),
    })

    await withWiredServer(
      async (fixture) => {
        const body = { idempotencyKey: 'continue-dedup-rev-001' }

        const first = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body,
        })
        expect(first.status).toBe(200)
        const firstBody = await fixture.json<Record<string, unknown>>(first)
        const firstJobId = (firstBody['activeJob'] as Record<string, unknown>)['id']

        const second = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body,
        })

        expect(second.status).toBe(200)
        const secondBody = await fixture.json<Record<string, unknown>>(second)
        const secondJobId = (secondBody['activeJob'] as Record<string, unknown>)['id']

        // Same job ID returned (deduped)
        expect(secondJobId).toBe(firstJobId)
      },
      { wrkf }
    )
  })

  test('[RED] waiting instance → 200 but NO new job admitted', async () => {
    // If the task is waiting for human input, /continue should return projection
    // without admitting a new continuation job
    const wrkf = makeProductFakePort({ next: async () => CLARIFICATION_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: { idempotencyKey: 'continue-waiting-001' },
        })

        expect(response.status).toBe(200)

        // No job queued for a waiting instance
        const queuedJobs = fixture.stateStore.pbcContinuationJobs
          .listByStatus('queued')
          .filter((j) => j.taskId === TASK)
        expect(queuedJobs).toHaveLength(0)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/continue`,
        body: { idempotencyKey: 'continue-no-wrkf' },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

describe('GET /v1/pbc/jobs/:jobId — job status (RED)', () => {
  test('[RED] returns job record by ID from pbc_continuation_jobs', async () => {
    await withWiredServer(async (fixture) => {
      // Pre-seed a job record
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '5',
        idempotencyKey: 'job-get-test-001',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })

      expect(response.status).toBe(200)
      const body = await fixture.json<Record<string, unknown>>(response)

      expect(body['id']).toBe(job.jobId)
      expect(body['taskId']).toBe(TASK)
      expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
      expect(typeof body['status']).toBe('string')
    })
  })

  test('[RED] returns 404 for unknown jobId', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/pbc/jobs/job_nonexistent_xyz',
      })

      expect(response.status).toBe(404)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toMatch(/NOT_FOUND|JOB_NOT_FOUND/)
    })
  })

  test('[RED] job status field is a valid status value', async () => {
    await withWiredServer(async (fixture) => {
      const { job } = fixture.stateStore.pbcContinuationJobs.admit({
        taskId: TASK,
        workflowRef: PBC_WORKFLOW_REF,
        revisionAtAdmission: '3',
        idempotencyKey: 'job-status-check-001',
      })

      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/jobs/${job.jobId}`,
      })
      expect(response.status).toBe(200)
      const body = await fixture.json<Record<string, unknown>>(response)

      const validStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
      expect(validStatuses).toContain(body['status'])
    })
  })
})

describe('contextHash is diagnostics-only — NOT a required mutation input (RED)', () => {
  test('[RED T-04045] failed terminal job surfaces as lastJob with stopReason when no active job', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const { job } = fixture.stateStore.pbcContinuationJobs.admit({
          taskId: TASK,
          workflowRef: PBC_WORKFLOW_REF,
          revisionAtAdmission: '3',
          idempotencyKey: 'lastjob-test-1',
        })
        fixture.stateStore.pbcContinuationJobs.transition({
          jobId: job.jobId,
          toStatus: 'failed',
          stopReason: 'missing_final_assistant_text',
        })

        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // No running/queued job → activeJob absent, but the terminal failure
        // must stay visible so fresh page loads can tell "failed" from "idle".
        expect(body['activeJob']).toBeUndefined()
        const lastJob = body['lastJob'] as Record<string, unknown>
        expect(lastJob).toBeDefined()
        expect(lastJob['id']).toBe(job.jobId)
        expect(lastJob['status']).toBe('failed')
        expect(lastJob['stopReason']).toBe('missing_final_assistant_text')
      },
      { wrkf }
    )
  })

  test('[RED T-04045] running job still projects as activeJob, no lastJob duplicate', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        fixture.stateStore.pbcContinuationJobs.admit({
          taskId: TASK,
          workflowRef: PBC_WORKFLOW_REF,
          revisionAtAdmission: '3',
          idempotencyKey: 'lastjob-test-2',
        })

        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['activeJob']).toBeDefined()
        expect(body['lastJob']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] /continue: body WITHOUT contextHash still returns 200 (not required)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/continue`,
          body: {
            idempotencyKey: 'continue-no-ctx-hash',
            // NO contextHash in body
          },
        })

        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })
})
