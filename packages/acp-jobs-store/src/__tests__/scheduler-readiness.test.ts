import { expect, test } from 'bun:test'
import { createInMemoryJobsStore } from '../open-store.js'

const now = '2026-11-03T19:00:00.000Z'
test('idle stores wait until there is recoverable work', () => {
  const store = createInMemoryJobsStore()
  try {
    expect(store.hasSchedulerWork(now)).toBe(false)
    const job = store.createJob({
      projectId: 'test',
      agentId: 'cody',
      scopeRef: 'agent:cody:project:test',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'test' },
      createdAt: '2026-11-03T18:30:00.000Z',
    }).job
    store.appendJobRun({
      jobId: job.jobId,
      status: 'claimed',
      triggeredBy: 'manual',
      triggeredAt: now,
    })
    // A non-flow claim without an expiry is not a candidate of any tick path.
    expect(store.hasSchedulerWork(now)).toBe(false)
    store.appendJobRun({
      jobId: job.jobId,
      status: 'claimed',
      triggeredBy: 'manual',
      triggeredAt: now,
      leaseExpiresAt: now,
    })
    expect(store.hasSchedulerWork(now)).toBe(true)
  } finally {
    store.close()
  }
})
test('pending event inbox work wakes an otherwise idle scheduler', () => {
  const store = createInMemoryJobsStore()
  try {
    const event = store.insertInboxEvent({
      eventId: 'wake',
      eventSeq: 1,
      event: 'task.changed',
      payload: {},
    }).event
    expect(store.hasSchedulerWork(now)).toBe(true)
    store.markInboxEventProcessed(event.eventId, now)
    expect(store.hasSchedulerWork(now)).toBe(false)
  } finally {
    store.close()
  }
})

test('foreign recovery cannot wake this node, local recovery and inbox still do', () => {
  const store = createInMemoryJobsStore()
  const identity = { nodeId: 'svc', mode: 'federated' as const, verifiedAt: now }
  try {
    const job = store.createJob({
      projectId: 'test',
      agentId: 'cody',
      scopeRef: 'agent:cody:project:test',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'test' },
      createdAt: now,
    }).job
    const run = store.appendJobRun({
      jobId: job.jobId,
      triggeredAt: now,
      triggeredBy: 'manual',
      status: 'dispatched',
      executionNodeId: 'max3',
    }).jobRun
    expect(store.hasSchedulerWork(now, identity)).toBe(false)
    store.updateJobRun(run.jobRunId, { status: 'succeeded' })
    const localRun = store.appendJobRun({
      jobId: job.jobId,
      triggeredAt: now,
      triggeredBy: 'manual',
      status: 'dispatched',
      executionNodeId: 'svc',
    }).jobRun
    expect(store.hasSchedulerWork(now, identity)).toBe(true)
    store.updateJobRun(localRun.jobRunId, { status: 'succeeded' })
    expect(store.hasSchedulerWork(now, identity)).toBe(false)
    store.insertInboxEvent({
      eventId: 'local-wake',
      eventSeq: 1,
      event: 'task.changed',
      payload: {},
    })
    expect(store.hasSchedulerWork(now, identity)).toBe(true)
  } finally {
    store.close()
  }
})
