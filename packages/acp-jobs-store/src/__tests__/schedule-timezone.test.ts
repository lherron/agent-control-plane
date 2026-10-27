import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore, nextFireAfter, tickJobsScheduler } from '../index.js'

const CHICAGO = 'America/Chicago'

function fires(cron: string, afterIso: string, count: number, timezone?: string): string[] {
  const out: string[] = []
  let cursor: string | null = afterIso
  for (let index = 0; index < count; index += 1) {
    cursor = nextFireAfter(cron, cursor, timezone)
    if (cursor === null) break
    out.push(cursor)
  }
  return out
}

describe('nextFireAfter with an IANA timezone', () => {
  test('no timezone keeps the UTC walk, and an explicit UTC zone matches it', () => {
    const crons = ['0 2 * * *', '*/15 * * * *', '30 9 * * 1-5', '0 0 1 * *', '5,35 */3 * * *']
    for (const cron of crons) {
      for (const after of ['2026-03-07T12:34:56.000Z', '2026-10-31T23:59:00.000Z']) {
        const legacy = fires(cron, after, 20)
        expect(fires(cron, after, 20, 'UTC')).toEqual(legacy)
      }
    }
    expect(nextFireAfter('0 2 * * *', '2026-03-07T12:00:00.000Z')).toBe('2026-03-08T02:00:00.000Z')
    expect(fires('*/15 * * * *', '2026-03-07T12:34:56.000Z', 3)).toEqual([
      '2026-03-07T12:45:00.000Z',
      '2026-03-07T13:00:00.000Z',
      '2026-03-07T13:15:00.000Z',
    ])
    expect(fires('30 9 * * 1-5', '2026-03-07T12:34:56.000Z', 3)).toEqual([
      '2026-03-09T09:30:00.000Z',
      '2026-03-10T09:30:00.000Z',
      '2026-03-11T09:30:00.000Z',
    ])
  })

  test('02:00 Chicago on a normal CST day fires 08:00Z and on a CDT day 07:00Z', () => {
    expect(nextFireAfter('0 2 * * *', '2026-01-15T00:00:00.000Z', CHICAGO)).toBe(
      '2026-01-15T08:00:00.000Z'
    )
    expect(nextFireAfter('0 2 * * *', '2026-07-15T00:00:00.000Z', CHICAGO)).toBe(
      '2026-07-15T07:00:00.000Z'
    )
  })

  test('02:00 Chicago in the 2026-03-08 spring-forward gap fires once at 03:00 CDT', () => {
    expect(fires('0 2 * * *', '2026-03-07T00:00:00.000Z', 3, CHICAGO)).toEqual([
      '2026-03-07T08:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T07:00:00.000Z',
    ])
    expect(fires('30 2 * * *', '2026-03-08T00:00:00.000Z', 2, CHICAGO)).toEqual([
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T07:30:00.000Z',
    ])
  })

  test('a fixed-time job outside the gap is not pulled forward to the gap end', () => {
    expect(fires('0 3 * * *', '2026-03-08T00:00:00.000Z', 2, CHICAGO)).toEqual([
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T08:00:00.000Z',
    ])
    expect(nextFireAfter('0 4 * * *', '2026-03-08T00:00:00.000Z', CHICAGO)).toBe(
      '2026-03-08T09:00:00.000Z'
    )
  })

  test('01:30 Chicago across the 2026-11-01 fall-back overlap fires once, on the first occurrence', () => {
    expect(fires('30 1 * * *', '2026-10-31T12:00:00.000Z', 3, CHICAGO)).toEqual([
      '2026-11-01T06:30:00.000Z',
      '2026-11-02T07:30:00.000Z',
      '2026-11-03T07:30:00.000Z',
    ])
    expect(nextFireAfter('0 1 * * *', '2026-11-01T06:00:00.000Z', CHICAGO)).toBe(
      '2026-11-02T07:00:00.000Z'
    )
  })

  test('wildcard and step entries keep firing on UTC minutes through the overlap', () => {
    expect(fires('*/15 * * * *', '2026-11-01T06:40:00.000Z', 6, CHICAGO)).toEqual([
      '2026-11-01T06:45:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T07:15:00.000Z',
      '2026-11-01T07:30:00.000Z',
      '2026-11-01T07:45:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ])
  })

  test('day fields match the local calendar day', () => {
    // 20:00 CDT Monday = 01:00Z Tuesday.
    expect(nextFireAfter('0 20 * * 1', '2026-10-12T00:00:00.000Z', CHICAGO)).toBe(
      '2026-10-13T01:00:00.000Z'
    )
  })
})

describe('jobs store schedule timezone', () => {
  function createChicagoJob(
    store: ReturnType<typeof createInMemoryJobsStore>,
    cron: string,
    createdAt: string
  ) {
    return store.createJob({
      agentId: 'larry',
      projectId: 'demo-project',
      scopeRef: 'agent:larry:project:demo-project',
      laneRef: 'main',
      schedule: { cron, timezone: CHICAGO },
      input: { content: 'daily report' },
      disabled: false,
      createdAt,
    }).job
  }

  test('round-trips timezone and computes next_fire_at in that zone', () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createChicagoJob(store, '0 2 * * *', '2026-03-07T12:00:00.000Z')
      expect(job.nextFireAt).toBe('2026-03-08T08:00:00.000Z')
      expect(job.trigger).toEqual({ kind: 'schedule', cron: '0 2 * * *', timezone: CHICAGO })
      expect(job.schedule?.timezone).toBe(CHICAGO)

      const reread = store.getJob(job.jobId).job
      expect(reread?.schedule?.timezone).toBe(CHICAGO)
      expect(reread?.trigger).toEqual(job.trigger)
    } finally {
      store.close()
    }
  })

  test('the scheduler advances next_fire_at in the zone and never double-fires the overlap', async () => {
    const store = createInMemoryJobsStore()
    try {
      const job = createChicagoJob(store, '30 1 * * *', '2026-10-31T12:00:00.000Z')
      expect(job.nextFireAt).toBe('2026-11-01T06:30:00.000Z')

      const first = await tickJobsScheduler({ store, now: '2026-11-01T06:30:00.000Z' })
      expect(first).toHaveLength(1)
      expect(store.getJob(job.jobId).job?.nextFireAt).toBe('2026-11-02T07:30:00.000Z')

      const second = await tickJobsScheduler({ store, now: '2026-11-01T07:30:00.000Z' })
      expect(second).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  test('rejects a timezone that is not an IANA zone', () => {
    const store = createInMemoryJobsStore()
    try {
      expect(() =>
        store.createJob({
          agentId: 'larry',
          projectId: 'demo-project',
          scopeRef: 'agent:larry:project:demo-project',
          laneRef: 'main',
          trigger: { kind: 'schedule', cron: '0 2 * * *', timezone: 'America/Nowhere' },
          input: { content: 'daily report' },
          disabled: false,
          createdAt: '2026-03-07T12:00:00.000Z',
        })
      ).toThrow(/trigger\.timezone/)
      expect(() =>
        store.createJob({
          agentId: 'larry',
          projectId: 'demo-project',
          scopeRef: 'agent:larry:project:demo-project',
          laneRef: 'main',
          schedule: { cron: '0 2 * * *', timezone: 'Not/AZone' },
          input: { content: 'daily report' },
          disabled: false,
          createdAt: '2026-03-07T12:00:00.000Z',
        })
      ).toThrow(/trigger\.timezone/)
    } finally {
      store.close()
    }
  })
})
