import { describe, expect, test } from 'bun:test'

import {
  JobExecutionAdmissionError,
  type JobExecutionIdentity,
  createInMemoryJobsStore,
  tickJobsScheduler,
} from '../index.js'

const NOW = '2026-07-23T12:05:00.000Z'
const SVC: JobExecutionIdentity = {
  nodeId: 'svc',
  mode: 'federated',
  verifiedAt: NOW,
}
const MAX3: JobExecutionIdentity = {
  nodeId: 'max3',
  mode: 'federated',
  verifiedAt: NOW,
}
const THIRD: JobExecutionIdentity = {
  nodeId: 'third',
  mode: 'federated',
  verifiedAt: NOW,
}

function createScheduleJob(
  store: ReturnType<typeof createInMemoryJobsStore>,
  executionNodes?: readonly string[]
) {
  return store.createJob({
    agentId: 'cody',
    projectId: 'agent-control-plane',
    scopeRef: 'agent:cody:project:agent-control-plane:task:T-06804',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'owned schedule' },
    ...(executionNodes !== undefined ? { executionNodes } : {}),
    createdAt: '2026-07-23T12:00:00.000Z',
  }).job
}

describe('job execution owner-set admission', () => {
  test('admits every listed owner independently, stamps the admitting node, and leaves a non-owner due time untouched', async () => {
    for (const identity of [SVC, MAX3]) {
      const store = createInMemoryJobsStore()
      try {
        const job = createScheduleJob(store, ['max3', 'svc'])
        const runs = await tickJobsScheduler({ store, now: NOW, executionIdentity: identity })
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatchObject({
          jobId: job.jobId,
          executionNodeId: identity.nodeId,
        })
      } finally {
        store.close()
      }
    }

    const store = createInMemoryJobsStore()
    try {
      const job = createScheduleJob(store, ['max3', 'svc'])
      const before = store.getJob(job.jobId).job?.nextFireAt
      expect(await tickJobsScheduler({ store, now: NOW, executionIdentity: THIRD })).toHaveLength(0)
      expect(store.listJobRuns(job.jobId).jobRuns).toHaveLength(0)
      expect(store.getJob(job.jobId).job?.nextFireAt).toBe(before)
    } finally {
      store.close()
    }
  })

  test('supports all, rejects unassigned federated work, and preserves legacy single-node ownership', async () => {
    const allStore = createInMemoryJobsStore()
    const unassignedStore = createInMemoryJobsStore()
    const legacyStore = createInMemoryJobsStore()
    try {
      const allJob = createScheduleJob(allStore, ['all'])
      const allRuns = await tickJobsScheduler({
        store: allStore,
        now: NOW,
        executionIdentity: THIRD,
      })
      expect(allRuns[0]).toMatchObject({
        jobId: allJob.jobId,
        executionNodeId: THIRD.nodeId,
      })

      const unassigned = createScheduleJob(unassignedStore)
      expect(
        await tickJobsScheduler({
          store: unassignedStore,
          now: NOW,
          executionIdentity: SVC,
        })
      ).toHaveLength(0)
      expect(unassignedStore.listJobRuns(unassigned.jobId).jobRuns).toHaveLength(0)

      const legacy = createScheduleJob(legacyStore)
      const singleNode = { ...SVC, mode: 'single-node' as const }
      const legacyRuns = await tickJobsScheduler({
        store: legacyStore,
        now: NOW,
        executionIdentity: singleNode,
      })
      expect(legacyRuns[0]).toMatchObject({
        jobId: legacy.jobId,
        executionNodeId: 'svc',
      })
    } finally {
      allStore.close()
      unassignedStore.close()
      legacyStore.close()
    }
  })

  test('manual mint re-reads disabled and owner-set state transactionally with zero side effects', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createScheduleJob(store, ['svc'])
      store.updateJob(job.jobId, { executionNodes: ['max3'] })

      expect(() =>
        store.createJobRun(
          job.jobId,
          {
            triggeredAt: NOW,
            triggeredBy: 'manual',
            status: 'claimed',
          },
          SVC
        )
      ).toThrow(JobExecutionAdmissionError)
      expect(store.listJobRuns(job.jobId).jobRuns).toHaveLength(0)

      store.updateJob(job.jobId, { executionNodes: ['svc'], disabled: true })
      expect(() =>
        store.createJobRun(
          job.jobId,
          {
            triggeredAt: NOW,
            triggeredBy: 'manual',
            status: 'claimed',
          },
          SVC
        )
      ).toThrow('disabled')
      expect(store.listJobRuns(job.jobId).jobRuns).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test('inflight lifecycle remains bound to the admitting node after owner and disabled changes', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = store.createJob({
        agentId: 'cody',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:cody:project:agent-control-plane:task:T-06804',
        schedule: { cron: '0 0 * * *' },
        input: { content: 'owned flow' },
        flow: { sequence: [{ id: 'continue', input: 'continue' }] },
        executionNodes: ['svc'],
        createdAt: '2026-07-22T00:00:00.000Z',
      }).job
      const run = store.createJobRun(
        job.jobId,
        {
          triggeredAt: '2026-07-23T11:00:00.000Z',
          triggeredBy: 'manual',
          status: 'claimed',
          claimedAt: '2026-07-23T11:00:00.000Z',
          leaseOwner: 'old-owner',
          leaseExpiresAt: '2026-07-23T11:30:00.000Z',
        },
        SVC
      ).jobRun

      store.updateJob(job.jobId, { executionNodes: ['max3'], disabled: true })
      expect(store.listInflightFlowJobRuns({ now: NOW, executionNodeId: 'max3' })).toHaveLength(0)
      expect(store.listInflightFlowJobRuns({ now: NOW, executionNodeId: 'svc' })).toHaveLength(1)

      const advanced: string[] = []
      await tickJobsScheduler({
        store,
        now: NOW,
        executionIdentity: SVC,
        advanceFlowJobRun: async (entry) => {
          advanced.push(entry.jobRun.jobRunId)
          return entry.jobRun
        },
      })
      expect(advanced).toEqual([run.jobRunId])
      expect(store.getJobRun(run.jobRunId).jobRun?.status).not.toBe('failed')
    } finally {
      store.close()
    }
  })

  test('non-flow output selection uses immutable run ownership rather than the live owner set', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createScheduleJob(store, ['svc'])
      const run = store.createJobRun(
        job.jobId,
        {
          triggeredAt: NOW,
          triggeredBy: 'manual',
          status: 'dispatched',
          dispatchedAt: NOW,
          runId: 'run_owned_by_svc',
        },
        SVC
      ).jobRun

      store.updateJob(job.jobId, { executionNodes: ['max3'] })
      expect(store.listDispatchedNonFlowJobRuns({ executionNodeId: 'max3' })).toHaveLength(0)
      expect(store.listDispatchedNonFlowJobRuns({ executionNodeId: 'svc' })).toEqual([
        expect.objectContaining({
          jobRun: expect.objectContaining({
            jobRunId: run.jobRunId,
            executionNodeId: 'svc',
          }),
        }),
      ])
    } finally {
      store.close()
    }
  })
})
