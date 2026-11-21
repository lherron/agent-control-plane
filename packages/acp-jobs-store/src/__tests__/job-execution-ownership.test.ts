import { describe, expect, test } from 'bun:test'

import { type JobExecutionIdentity, createInMemoryJobsStore, tickJobsScheduler } from '../index.js'

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
describe('job execution owner-set admission', () => {
  test('non-flow output selection uses immutable run ownership after a job is disabled', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = store.createJob({
        agentId: 'cody',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:cody:project:agent-control-plane',
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
        input: { content: 'collect output' },
      }).job
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

      store.updateJob(job.jobId, { disabled: true })
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
      ).toThrow(
        expect.objectContaining({
          name: 'JobExecutionAdmissionError',
          code: 'job_execution_disabled',
        })
      )
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
      const job = store.createJob({
        agentId: 'cody',
        projectId: 'agent-control-plane',
        scopeRef: 'agent:cody:project:agent-control-plane',
        trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
        input: { content: 'collect output' },
      }).job
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
