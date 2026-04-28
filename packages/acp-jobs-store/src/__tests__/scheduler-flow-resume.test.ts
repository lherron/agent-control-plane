import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, tickJobsScheduler } from '../index.js'

describe('scheduler resumes in-flight flow JobRuns', () => {
  test('tick advances claimed/dispatched flow JobRuns even when no cron is due', async () => {
    const store = createInMemoryJobsStore()

    const created = store.createJob({
      agentId: 'larry',
      projectId: 'demo',
      scopeRef: 'agent:larry:project:demo:role:resume',
      laneRef: 'main',
      schedule: { cron: '0 4 * * 1' },
      input: { content: 'unused — flow job' },
      flow: {
        sequence: [{ id: 'step1', input: 'first', expect: { outcome: 'succeeded' } }],
      },
      disabled: true,
      createdAt: '2026-04-28T00:00:00.000Z',
    })
    const jobId = created.job.jobId

    const triggered = store.appendJobRun({
      jobId,
      triggeredAt: '2026-04-28T00:00:00.000Z',
      triggeredBy: 'manual',
      status: 'dispatched',
      claimedAt: '2026-04-28T00:00:00.000Z',
      dispatchedAt: '2026-04-28T00:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
      actorStamp: 'system:test',
    }).jobRun

    const advanced: string[] = []
    const result = await tickJobsScheduler({
      store,
      now: '2026-04-28T00:00:30.000Z',
      advanceFlowJobRun: async (entry) => {
        advanced.push(entry.jobRun.jobRunId)
        return store.updateJobRun(entry.jobRun.jobRunId, {
          status: 'succeeded',
          completedAt: '2026-04-28T00:00:30.000Z',
        }).jobRun
      },
    })

    expect(advanced).toEqual([triggered.jobRunId])
    expect(result).toHaveLength(1)
    expect(result[0]?.status).toBe('succeeded')
  })

  test('tick does not double-advance a JobRun that was just claimed in the same tick', async () => {
    const store = createInMemoryJobsStore()

    const created = store.createJob({
      agentId: 'larry',
      projectId: 'demo',
      scopeRef: 'agent:larry:project:demo:role:doublecheck',
      laneRef: 'main',
      schedule: { cron: '* * * * *' },
      input: { content: 'unused' },
      flow: {
        sequence: [{ id: 'step1', input: 'x', expect: { outcome: 'succeeded' } }],
      },
      disabled: false,
      createdAt: '2026-04-28T00:00:00.000Z',
    })
    expect(created.job.jobId).toBeDefined()

    const advanced: string[] = []
    await tickJobsScheduler({
      store,
      now: '2026-04-28T00:01:00.000Z',
      advanceFlowJobRun: async (entry) => {
        advanced.push(entry.jobRun.jobRunId)
        return store.updateJobRun(entry.jobRun.jobRunId, {
          status: 'succeeded',
          completedAt: '2026-04-28T00:01:00.000Z',
        }).jobRun
      },
    })

    expect(advanced).toHaveLength(1)
  })

  test('listInflightFlowJobRuns ignores JobRuns whose job has no flow', async () => {
    const store = createInMemoryJobsStore()

    const legacy = store.createJob({
      agentId: 'larry',
      projectId: 'demo',
      scopeRef: 'agent:larry:project:demo:role:legacy',
      laneRef: 'main',
      schedule: { cron: '0 4 * * 1' },
      input: { content: 'legacy single-turn' },
      disabled: true,
      createdAt: '2026-04-28T00:00:00.000Z',
    })
    store.appendJobRun({
      jobId: legacy.job.jobId,
      triggeredAt: '2026-04-28T00:00:00.000Z',
      triggeredBy: 'manual',
      status: 'dispatched',
      claimedAt: '2026-04-28T00:00:00.000Z',
      actor: { kind: 'system', id: 'test' },
      actorStamp: 'system:test',
    })

    const inflight = store.listInflightFlowJobRuns()
    expect(inflight).toHaveLength(0)
  })
})
