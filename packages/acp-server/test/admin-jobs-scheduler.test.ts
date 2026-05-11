import { afterEach, describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

const originalSchedulerEnabled = process.env['ACP_SCHEDULER_ENABLED']
const originalSchedulerTickInterval = process.env['ACP_SCHEDULER_TICK_INTERVAL_MS']

afterEach(() => {
  if (originalSchedulerEnabled === undefined) {
    process.env['ACP_SCHEDULER_ENABLED'] = undefined
  } else {
    process.env['ACP_SCHEDULER_ENABLED'] = originalSchedulerEnabled
  }

  if (originalSchedulerTickInterval === undefined) {
    process.env['ACP_SCHEDULER_TICK_INTERVAL_MS'] = undefined
  } else {
    process.env['ACP_SCHEDULER_TICK_INTERVAL_MS'] = originalSchedulerTickInterval
  }
})

describe('admin jobs scheduler endpoint', () => {
  test('GET /v1/admin/jobs/scheduler returns scheduler state counts', async () => {
    const jobsStore = createInMemoryJobsStore()
    process.env['ACP_SCHEDULER_ENABLED'] = 'true'
    process.env['ACP_SCHEDULER_TICK_INTERVAL_MS'] = '7000'

    try {
      await withWiredServer(
        async (fixture) => {
          const dueJob = jobsStore.createJob({
            projectId: 'agent-spaces',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:agent-spaces',
            laneRef: 'main',
            schedule: { cron: '* * * * *' },
            input: { content: 'due' },
            createdAt: '2026-01-01T00:00:00.000Z',
          }).job
          jobsStore.createJob({
            projectId: 'agent-spaces',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:agent-spaces',
            laneRef: 'main',
            schedule: { cron: '* * * * *' },
            input: { content: 'disabled' },
            disabled: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          })
          jobsStore.appendJobRun({
            jobId: dueJob.jobId,
            triggeredAt: '2026-05-11T00:00:00.000Z',
            triggeredBy: 'schedule',
            status: 'claimed',
          })

          const response = await fixture.request({
            method: 'GET',
            path: '/v1/admin/jobs/scheduler',
          })
          expect(response.status).toBe(200)
          expect(
            await fixture.json<{
              enabled: boolean
              tickIntervalMs: number
              dueCount: number
              claimedCount: number
              errors: unknown[]
              note?: string
            }>(response)
          ).toEqual({
            enabled: true,
            tickIntervalMs: 7000,
            dueCount: 1,
            claimedCount: 1,
            errors: [],
            note: expect.stringContaining('lastTickAt'),
          })
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
