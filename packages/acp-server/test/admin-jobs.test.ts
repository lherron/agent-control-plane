import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { InMemoryInputAttemptStore, type AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
}

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      return {
        runId: input.acpRunId ?? 'run-launch-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

async function createJob(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never
): Promise<{ job: { jobId: string } }> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/admin/jobs',
    body: {
      agentId: 'larry',
      projectId: fixture.seed.projectId,
      scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
      laneRef: 'main',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'run the jobs workflow' },
    },
  })

  expect(response.status).toBe(201)
  return fixture.json<{ job: { jobId: string } }>(response)
}

async function createJobRun(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never,
  jobId: string
): Promise<{ jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string } }> {
  const response = await fixture.request({
    method: 'POST',
    path: `/v1/admin/jobs/${jobId}/run`,
  })

  expect(response.status).toBe(202)
  return fixture.json<{
    jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string }
  }>(response)
}

describe('admin jobs routes', () => {
  test('POST /v1/admin/jobs creates a durable scheduled job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/jobs',
          body: {
            agentId: 'larry',
            projectId: fixture.seed.projectId,
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
            laneRef: 'main',
            schedule: { cron: '*/5 * * * *' },
            input: { content: 'run the jobs workflow' },
            disabled: false,
          },
        })
        const payload = await fixture.json<{
          job: {
            jobId: string
            projectId: string
            schedule: { cron: string }
            input: { content: string }
            disabled: boolean
          }
        }>(response)

        expect(response.status).toBe(201)
        expect(payload.job).toEqual(
          expect.objectContaining({
            jobId: expect.stringMatching(/^job_/),
            projectId: fixture.seed.projectId,
            schedule: expect.objectContaining({ cron: '*/5 * * * *' }),
            input: expect.objectContaining({ content: 'run the jobs workflow' }),
            disabled: false,
          })
        )
      }, { jobsStore })
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/admin/jobs lists jobs and supports projectId filtering', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(async (fixture) => {
        await createJob(fixture)

        const response = await fixture.request({
          method: 'GET',
          path: `/v1/admin/jobs?projectId=${fixture.seed.projectId}`,
        })
        const payload = await fixture.json<{ jobs: Array<{ projectId: string }> }>(response)

        expect(response.status).toBe(200)
        expect(payload.jobs).not.toHaveLength(0)
        expect(payload.jobs.every((job) => job.projectId === fixture.seed.projectId)).toBe(true)
      }, { jobsStore })
    } finally {
      jobsStore.close()
    }
  })

  test('PATCH /v1/admin/jobs/:jobId updates schedule and disabled state', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(async (fixture) => {
        const created = await createJob(fixture)

        const response = await fixture.request({
          method: 'PATCH',
          path: `/v1/admin/jobs/${created.job.jobId}`,
          body: {
            schedule: { cron: '0 * * * *' },
            disabled: true,
          },
        })
        const payload = await fixture.json<{
          job: { jobId: string; schedule: { cron: string }; disabled: boolean }
        }>(response)

        expect(response.status).toBe(200)
        expect(payload.job).toEqual(
          expect.objectContaining({
            jobId: created.job.jobId,
            schedule: expect.objectContaining({ cron: '0 * * * *' }),
            disabled: true,
          })
        )
      }, { jobsStore })
    } finally {
      jobsStore.close()
    }
  })

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

  test('GET /v1/jobs/:jobId/runs lists job-runs for a job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(async (fixture) => {
        const created = await createJob(fixture)
        await createJobRun(fixture, created.job.jobId)

        const response = await fixture.request({
          method: 'GET',
          path: `/v1/jobs/${created.job.jobId}/runs`,
        })
        const payload = await fixture.json<{ jobRuns: Array<{ jobId: string }> }>(response)

        expect(response.status).toBe(200)
        expect(payload.jobRuns).not.toHaveLength(0)
        expect(payload.jobRuns.every((jobRun) => jobRun.jobId === created.job.jobId)).toBe(true)
      }, { jobsStore })
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/job-runs/:jobRunId returns one correlated job-run', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(async (fixture) => {
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
      }, { jobsStore })
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

          expect(inputAttemptStore.calls).toHaveLength(1)
          expect(inputAttemptStore.calls[0]).toEqual(
            expect.objectContaining({
              metadata: expect.objectContaining({
                source: {
                  kind: 'job',
                  jobId: created.job.jobId,
                  jobRunId: payload.jobRun.jobRunId,
                },
              }),
            })
          )
          expect(launchCalls).toHaveLength(1)
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
