import { describe, expect, test } from 'bun:test'
import { createInMemoryJobsStore } from 'acp-jobs-store'
import type { AcpServerDeps } from '../src/index.js'
import { createJobNodeIdentityAuthority } from '../src/jobs/node-identity.js'
import { RecordingInputAttemptStore } from './fixtures/flow-engine.js'
import { type LaunchCall, admissionRuntime } from './fixtures/input-admission.js'
import { createJob, createJobRun } from './fixtures/jobs-routes.js'
import { withWiredServer } from './fixtures/wired-server.js'

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => admissionRuntime(),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      return {
        runId: input.acpRunId ?? 'run-launch-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

describe('admin manual job runs', () => {
  test('POST /v1/admin/jobs/:jobId/run creates a manual job-run and dispatches through /inputs', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          expect(response.status).toBe(202)
          const payload = await fixture.json<{
            jobRun: {
              jobRunId: string
              jobId: string
              triggeredBy: string
              status: string
              inputAttemptId: string
              runId: string
            }
          }>(response)

          expect(payload.jobRun).toEqual(
            expect.objectContaining({
              jobRunId: expect.any(String),
              jobId: created.job.jobId,
              triggeredBy: 'manual',
              status: expect.stringMatching(/dispatched|succeeded|running|pending/),
              inputAttemptId: expect.any(String),
              runId: expect.any(String),
            })
          )
          expect(launchCalls).toHaveLength(1)
          expect(launchCalls[0]).toEqual(
            expect.objectContaining({
              inputAttemptId: payload.jobRun.inputAttemptId,
              acpRunId: payload.jobRun.runId,
            })
          )
        },
        {
          jobsStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('manual run fails closed before mint or dispatch when the fresh HRC identity read fails', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []
    let statusCalls = 0
    const identityAuthority = createJobNodeIdentityAuthority({
      getStatus: (async () => {
        statusCalls += 1
        if (statusCalls === 1) {
          return { node: { nodeId: 'svc', mode: 'federated' } }
        }
        throw new Error('fresh status unavailable')
      }) as never,
    })
    await identityAuthority.initialize()

    try {
      await withWiredServer(
        async (fixture) => {
          // Disabled: federated create refuses an enabled unowned schedule, and
          // the fresh identity read fails before admission looks at the job.
          const created = await createJob(fixture, { disabled: true })
          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            error: { code: string; details: { jobId: string } }
          }>(response)

          expect(response.status).toBe(409)
          expect(payload.error).toMatchObject({
            code: 'hrc_identity_unavailable',
            details: { jobId: created.job.jobId },
          })
          expect(statusCalls).toBe(2)
          expect(jobsStore.listJobRuns(created.job.jobId).jobRuns).toHaveLength(0)
          expect(launchCalls).toHaveLength(0)
        },
        {
          jobsStore,
          jobNodeIdentityAuthority: identityAuthority,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/jobs/:jobId/runs lists job-runs for a job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const createdRun = await createJobRun(fixture, created.job.jobId)
          const other = await createJob(fixture, {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01176:role:implementer`,
          })
          await createJobRun(fixture, other.job.jobId)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/jobs/${created.job.jobId}/runs`,
          })
          const payload = await fixture.json<{
            jobRuns: Array<{ jobRunId: string; jobId: string }>
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRuns.map((jobRun) => jobRun.jobRunId)).toEqual([
            createdRun.jobRun.jobRunId,
          ])
          expect(payload.jobRuns.every((jobRun) => jobRun.jobId === created.job.jobId)).toBe(true)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/job-runs/:jobRunId returns one correlated job-run', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const createdRun = await createJobRun(fixture, created.job.jobId)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${createdRun.jobRun.jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun).toEqual(
            expect.objectContaining({
              jobRunId: createdRun.jobRun.jobRunId,
              jobId: created.job.jobId,
              inputAttemptId: createdRun.jobRun.inputAttemptId,
              runId: createdRun.jobRun.runId,
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('manual run dispatch records job source metadata exactly once on the input attempt', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const payload = await createJobRun(fixture, created.job.jobId)

          const attemptResponse = await fixture.request({
            method: 'GET',
            path: `/v1/input-attempts/${payload.jobRun.inputAttemptId}`,
          })
          expect(attemptResponse.status).toBe(200)
          const attempt = await fixture.json<{
            inputAttempt: { idempotencyKey?: string; metadata?: Record<string, unknown> }
          }>(attemptResponse)

          expect(inputAttemptStore.calls).toHaveLength(1)
          // Single-turn (legacy) job runs key the attempt by jobRunId and carry no step fields.
          expect(attempt.inputAttempt.idempotencyKey).toBe(payload.jobRun.jobRunId)
          expect(attempt.inputAttempt.metadata?.['source']).toEqual({
            kind: 'job',
            jobId: created.job.jobId,
            jobRunId: payload.jobRun.jobRunId,
          })
          expect(launchCalls).toHaveLength(1)
          expect(launchCalls[0]?.inputAttemptId).toBe(payload.jobRun.inputAttemptId)
        },
        {
          jobsStore,
          inputAttemptStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })
})
