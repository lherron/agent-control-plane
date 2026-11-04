import { expect, test } from 'bun:test'
import { createInMemoryJobsStore } from '../open-store.js'

const now = '2026-11-03T19:00:00.000Z'
test('empty and future schedule ticks require no HRC identity; due work does', () => {
  const store = createInMemoryJobsStore()
  try {
    expect(store.hasSchedulerWork(now)).toBe(false)
    const job = store.createJob({
      projectId: 'test',
      agentId: 'cody',
      scopeRef: 'agent:cody:project:test',
      schedule: { cron: '0 * * * *' },
      input: { content: 'test' },
      createdAt: '2026-11-03T18:30:00.000Z',
    }).job
    expect(store.hasSchedulerWork('2026-11-03T18:31:00.000Z')).toBe(false)
    expect(store.hasSchedulerWork(now)).toBe(true)
    store.updateJob(job.jobId, { disabled: true })
    expect(store.hasSchedulerWork(now)).toBe(false)
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

// svc retained July schedules without owners. Admission refused them forever,
// but the broad readiness hint still forced a fresh HRC status every 5 s.
test('unowned federated and foreign-owned due jobs cannot wake this node', () => {
  const store = createInMemoryJobsStore()
  const identity = { nodeId: 'svc', mode: 'federated' as const, verifiedAt: now }
  try {
    const job = store.createJob({
      projectId: 'test',
      agentId: 'cody',
      scopeRef: 'agent:cody:project:test',
      schedule: { cron: '* * * * *' },
      input: { content: 'test' },
      createdAt: '2026-07-01T00:00:00.000Z',
    }).job
    expect(store.hasSchedulerWork(now)).toBe(true) // no baseline: conservative
    expect(store.hasSchedulerWork(now, identity)).toBe(false)
    expect(
      store.hasSchedulerWork(now, { nodeId: 'svc', mode: 'single-node', verifiedAt: now })
    ).toBe(true)
    store.updateJob(job.jobId, { executionNodes: ['max3'] })
    expect(store.hasSchedulerWork(now, identity)).toBe(false)
    store.updateJob(job.jobId, { executionNodes: ['svc'] })
    expect(store.hasSchedulerWork(now, identity)).toBe(true)
    store.updateJob(job.jobId, { executionNodes: ['all'] })
    expect(store.hasSchedulerWork(now, identity)).toBe(true)
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
      schedule: { cron: '0 * * * *' },
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

test('excluded schedules are reported once at baseline and when exclusion changes', () => {
  const store = createInMemoryJobsStore()
  const identity = { nodeId: 'svc', mode: 'federated' as const, verifiedAt: now }
  const reported: string[] = []
  const report = (refusal: { code: string }) => reported.push(refusal.code)
  try {
    const job = store.createJob({
      projectId: 'test',
      agentId: 'cody',
      scopeRef: 'agent:cody:project:test',
      schedule: { cron: '0 * * * *' },
      input: { content: 'test' },
      createdAt: now,
    }).job
    expect(store.hasSchedulerWork(now, identity, report)).toBe(false)
    store.hasSchedulerWork(now, identity, report)
    expect(reported).toEqual(['job_execution_unassigned_federated'])
    store.updateJob(job.jobId, { executionNodes: ['max3'] })
    store.hasSchedulerWork(now, identity, report)
    expect(reported).toEqual(['job_execution_unassigned_federated', 'job_execution_wrong_node'])
    store.updateJob(job.jobId, { executionNodes: ['svc'] })
    store.hasSchedulerWork(now, identity, report)
    store.updateJob(job.jobId, { executionNodes: ['max3'] })
    store.hasSchedulerWork(now, identity, report)
    expect(reported).toHaveLength(3)
  } finally {
    store.close()
  }
})
