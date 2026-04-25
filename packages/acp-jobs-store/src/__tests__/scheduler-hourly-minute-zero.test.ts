import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, tickJobsScheduler } from '../index.js'

describe('hourly minute-zero scheduler contract', () => {
  test('initial scheduling stores the next 0 * * * * fire time at the next hour boundary', () => {
    const store = createInMemoryJobsStore()

    try {
      const { job } = store.createJob({
        agentId: 'larry',
        projectId: 'demo-project',
        scopeRef: 'agent:larry:project:demo-project:task:T-01256:role:implementer',
        laneRef: 'main',
        schedule: { cron: '0 * * * *' },
        input: { content: 'hourly wake' },
        disabled: false,
        createdAt: '2026-04-25T12:30:00.000Z',
      })

      expect(job.nextFireAt).toBe('2026-04-25T13:00:00.000Z')
    } finally {
      store.close()
    }
  })

  test('null next-fire fallback claims 0 * * * * jobs at the current minute-zero boundary', async () => {
    const store = createInMemoryJobsStore()

    try {
      const { job } = store.createJob({
        agentId: 'larry',
        projectId: 'demo-project',
        scopeRef: 'agent:larry:project:demo-project:task:T-01256:role:implementer',
        laneRef: 'main',
        schedule: { cron: '0 * * * *' },
        input: { content: 'hourly wake' },
        disabled: false,
        createdAt: '2026-04-25T12:30:00.000Z',
      })

      const claimed = await tickJobsScheduler({
        store,
        now: '2026-04-25T13:00:00.000Z',
      })

      if (claimed.length !== 1) {
        throw new Error(
          `Expected job ${job.jobId} to fire at missing minute-zero boundary 2026-04-25T13:00:00.000Z, got ${claimed.length} claimed runs`
        )
      }

      expect(claimed[0]).toEqual(
        expect.objectContaining({
          jobId: job.jobId,
          triggeredAt: '2026-04-25T13:00:00.000Z',
          triggeredBy: 'schedule',
          status: 'claimed',
        })
      )
    } finally {
      store.close()
    }
  })
})
