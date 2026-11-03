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
