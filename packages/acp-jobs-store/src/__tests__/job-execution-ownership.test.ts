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

  test('reports every admission refusal so an unassigned federated schedule cannot go quiet', async () => {
    const store = createInMemoryJobsStore()
    try {
      const unassigned = createScheduleJob(store)
      const foreign = createScheduleJob(store, ['max3'])
      const refusals: Array<{ jobId: string; code: string }> = []
      expect(
        await tickJobsScheduler({
          store,
          now: NOW,
          executionIdentity: SVC,
          onAdmissionRefused: (refusal) =>
            refusals.push({ jobId: refusal.job.jobId, code: refusal.code }),
        })
      ).toHaveLength(0)
      expect(refusals).toEqual(
        expect.arrayContaining([
          { jobId: unassigned.jobId, code: 'job_execution_unassigned_federated' },
          { jobId: foreign.jobId, code: 'job_execution_wrong_node' },
        ])
      )
      expect(refusals).toHaveLength(2)
    } finally {
      store.close()
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

describe('event-hook runs (T-09996)', () => {
  function createEventJob(store: ReturnType<typeof createInMemoryJobsStore>) {
    return store.createJob({
      agentId: 'scribe',
      projectId: 'agent-control-plane',
      scopeRef: 'agent:scribe:project:agent-control-plane:task:{{ticket_id}}',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'explain {{ticket_id}}' },
      createdAt: '2026-07-23T12:00:00.000Z',
    }).job
  }

  function ingest(store: ReturnType<typeof createInMemoryJobsStore>) {
    store.insertInboxEvent({
      eventId: 'wrkq:evt_1',
      eventSeq: 1,
      source: 'wrkq',
      event: 'created',
      payload: { event_id: 'evt_1' },
    })
  }

  const mintAll: Parameters<typeof tickJobsScheduler>[0]['evaluateEventJob'] = () => ({
    decision: 'mint',
    resolved: {
      scopeRef: 'agent:scribe:project:agent-control-plane:task:T-1',
      laneRef: 'main',
      input: { content: 'explain T-1' },
    },
    source: { kind: 'webhook', eventId: 'evt_1' },
  })

  test('a verified tick stamps the admitting node on minted event runs', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createEventJob(store)
      ingest(store)
      await tickJobsScheduler({
        store,
        now: NOW,
        executionIdentity: SVC,
        evaluateEventJob: mintAll,
      })
      const [run] = store.listJobRuns(job.jobId).jobRuns
      expect(run?.triggeredBy).toBe('webhook')
      expect(run?.executionNodeId).toBe('svc')
    } finally {
      store.close()
    }
  })

  // T-10378: event runs mint on the receiving node with no owner-set check, so
  // a manual run of the same event job must follow that placement rule rather
  // than the schedule-owner refusal (which made it unrunnable in federated mode).
  test('a manual run of an unowned event job is admitted and stamped in federated mode', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createEventJob(store)
      const { jobRun } = store.createJobRun(
        job.jobId,
        { triggeredAt: NOW, triggeredBy: 'manual', status: 'claimed', claimedAt: NOW },
        MAX3
      )
      expect(jobRun.executionNodeId).toBe('max3')
    } finally {
      store.close()
    }
  })

  test('a manual run of a disabled event job is still refused', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createEventJob(store)
      store.updateJob(job.jobId, { disabled: true })
      expect(() =>
        store.createJobRun(
          job.jobId,
          { triggeredAt: NOW, triggeredBy: 'manual', status: 'claimed', claimedAt: NOW },
          MAX3
        )
      ).toThrow(JobExecutionAdmissionError)
    } finally {
      store.close()
    }
  })

  test('a tick without a verified identity leaves event runs unstamped', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createEventJob(store)
      ingest(store)
      await tickJobsScheduler({ store, now: NOW, evaluateEventJob: mintAll })
      const [run] = store.listJobRuns(job.jobId).jobRuns
      expect(run?.triggeredBy).toBe('webhook')
      expect(run?.executionNodeId).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('runs whose sinks are all in backoff do not starve the output reconciler window', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createScheduleJob(store, ['svc'])
      const dispatch = (minute: number) =>
        store.createJobRun(
          job.jobId,
          {
            triggeredAt: NOW,
            triggeredBy: 'manual',
            status: 'dispatched',
            dispatchedAt: `2026-07-23T11:${String(minute).padStart(2, '0')}:00.000Z`,
            runId: `run_${minute}`,
          },
          SVC
        ).jobRun
      const backedOff = [0, 1, 2].map((minute) => dispatch(minute))
      for (const run of backedOff) {
        store.recordJobOutputSinkAttempt({
          jobRunId: run.jobRunId,
          sinkIndex: 0,
          sinkFingerprint: 'fp',
          status: 'failed',
          attemptedAt: NOW,
          nextAttemptAt: '2026-07-23T13:00:00.000Z',
          lastError: 'Unable to connect',
        })
      }
      const due = dispatch(30)
      const dueAttempt = dispatch(31)
      store.recordJobOutputSinkAttempt({
        jobRunId: dueAttempt.jobRunId,
        sinkIndex: 0,
        sinkFingerprint: 'fp',
        status: 'failed',
        attemptedAt: NOW,
        nextAttemptAt: '2026-07-23T12:00:00.000Z',
        lastError: 'Unable to connect',
      })

      const listed = store
        .listDispatchedNonFlowJobRuns({ executionNodeId: 'svc', now: NOW, limit: 2 })
        .map((entry) => entry.jobRun.jobRunId)
      expect(listed).toEqual([due.jobRunId, dueAttempt.jobRunId])
    } finally {
      store.close()
    }
  })
})
