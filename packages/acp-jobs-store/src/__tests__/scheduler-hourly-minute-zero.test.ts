import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

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
})
