import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, tickJobsScheduler } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin jobs hourly scheduler acceptance', () => {
  test('POST /v1/admin/jobs schedules 0 * * * * jobs that produce a JobRun at minute zero', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const createResponse = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01256:role:implementer`,
              laneRef: 'main',
              schedule: { cron: '0 * * * *' },
              input: { content: 'hourly wake from admin API' },
              disabled: false,
            },
          })

          expect(createResponse.status).toBe(201)
          const created = await fixture.json<{ job: { jobId: string } }>(createResponse)
          jobsStore.sqlite
            .prepare(
              `
                UPDATE jobs
                SET created_at = ?,
                    updated_at = ?,
                    next_fire_at = NULL
                WHERE job_id = ?
              `
            )
            .run('2026-04-25T12:30:00.000Z', '2026-04-25T12:30:00.000Z', created.job.jobId)

          await tickJobsScheduler({
            store: jobsStore,
            now: '2026-04-25T13:00:00.000Z',
          })

          const runsResponse = await fixture.request({
            method: 'GET',
            path: `/v1/jobs/${created.job.jobId}/runs`,
          })

          expect(runsResponse.status).toBe(200)
          const runsPayload = await fixture.json<{
            jobRuns: Array<{
              jobId: string
              triggeredAt: string
              triggeredBy: string
              status: string
            }>
          }>(runsResponse)

          const minuteZeroRun = runsPayload.jobRuns.find(
            (run) => run.triggeredAt === '2026-04-25T13:00:00.000Z'
          )

          if (minuteZeroRun === undefined) {
            throw new Error(
              `Expected admin-created hourly job ${created.job.jobId} to produce a JobRun at missing minute-zero boundary 2026-04-25T13:00:00.000Z, got ${JSON.stringify(runsPayload.jobRuns)}`
            )
          }

          expect(minuteZeroRun).toEqual(
            expect.objectContaining({
              jobId: created.job.jobId,
              triggeredBy: 'schedule',
              status: 'claimed',
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
