import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

function createScheduledJob(
  store: ReturnType<typeof createInMemoryJobsStore>,
  schedule: Record<string, unknown>,
  suffix: string
) {
  return store.createJob({
    projectId: 'acp',
    agentId: 'smokey',
    scopeRef: `agent:smokey:project:acp:task:T-05419:${suffix}`,
    laneRef: 'main',
    schedule: {
      cron: '0 8 * * *',
      ...schedule,
    },
    input: { content: `T-05419 ${suffix}` },
    createdAt: '2026-07-01T07:00:00.000Z',
  })
}

function listScheduleSkipRecords(
  store: ReturnType<typeof createInMemoryJobsStore>,
  jobId: string
): Record<string, unknown>[] {
  const publicStore = store as unknown as Record<string, unknown>
  const listSkipLedger =
    publicStore['listScheduleSkips'] ??
    publicStore['listScheduledJobSkips'] ??
    publicStore['listScheduleSkipRecords']

  if (typeof listSkipLedger === 'function') {
    const result = listSkipLedger.call(store, { jobId }) as
      | Record<string, unknown>[]
      | { skips?: Record<string, unknown>[]; records?: Record<string, unknown>[] }
    if (Array.isArray(result)) return result
    return result.skips ?? result.records ?? []
  }

  return store
    .listJobRuns(jobId)
    .jobRuns.filter((run) => run.status === 'skipped')
    .map((run) => run as unknown as Record<string, unknown>)
}

function expectRecordedScheduleSkip(
  store: ReturnType<typeof createInMemoryJobsStore>,
  jobId: string,
  reason: 'schedule_window' | 'stale_catch_up_suppressed'
) {
  const records = listScheduleSkipRecords(store, jobId)
  // T-05419: the skip must be observable through run history or a schedule-skip ledger.
  // It must not be a silent no-op, probe-idle success, or generic skipped outcome.
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        jobId,
        reason,
      }),
    ])
  )
}

describe('scheduled job windows and catch-up policy (T-05419 red)', () => {
  test('outside-window fires are skipped with a recorded schedule_window reason while inside-window catch-up still mints', () => {
    const outsideStore = createInMemoryJobsStore()
    try {
      const outside = createScheduledJob(
        outsideStore,
        { windowStart: '08:00', windowEnd: '18:00', windowMinutes: 720 },
        'outside-window'
      ).job

      const outsideClaim = outsideStore.claimDueJobs({ now: '2026-07-01T19:00:00.000Z' })
      expect(outsideClaim.filter((entry) => entry.job.jobId === outside.jobId)).toHaveLength(0)
      expectRecordedScheduleSkip(outsideStore, outside.jobId, 'schedule_window')
    } finally {
      outsideStore.close()
    }

    const insideStore = createInMemoryJobsStore()
    try {
      const inside = createScheduledJob(
        insideStore,
        { windowStart: '08:00', windowEnd: '18:00', windowMinutes: 720 },
        'inside-window'
      ).job

      const insideClaim = insideStore.claimDueJobs({ now: '2026-07-01T09:00:00.000Z' })
      expect(insideClaim).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            job: expect.objectContaining({ jobId: inside.jobId }),
            jobRun: expect.objectContaining({ triggeredBy: 'catch-up', status: 'claimed' }),
          }),
        ])
      )
    } finally {
      insideStore.close()
    }
  })

  test('windowMinutes suppresses stale catch-up distinctly from schedule-window skips', () => {
    const store = createInMemoryJobsStore()
    try {
      const staleNone = createScheduledJob(
        store,
        { windowStart: '08:00', windowEnd: '18:00', windowMinutes: 30, catchUp: 'none' },
        'catch-up-none'
      ).job
      const staleOne = createScheduledJob(
        store,
        { windowStart: '08:00', windowEnd: '18:00', windowMinutes: 180, catchUp: 'one' },
        'catch-up-one'
      ).job

      const claimed = store.claimDueJobs({ now: '2026-07-01T09:00:00.000Z' })
      expect(claimed.filter((entry) => entry.job.jobId === staleNone.jobId)).toHaveLength(0)
      expectRecordedScheduleSkip(store, staleNone.jobId, 'stale_catch_up_suppressed')

      // Negative guard: the same stale fire remains claimable when catchUp=one and
      // the staleness is inside the job's windowMinutes bound.
      expect(claimed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            job: expect.objectContaining({ jobId: staleOne.jobId }),
            jobRun: expect.objectContaining({ triggeredBy: 'catch-up', status: 'claimed' }),
          }),
        ])
      )
    } finally {
      store.close()
    }
  })

  test('labels exact-minute and mid-minute ticks as schedule, reserving catch-up for genuinely stale fires', () => {
    const exactStore = createInMemoryJobsStore()
    try {
      const exact = createScheduledJob(exactStore, {}, 'exact-minute').job

      const exactClaim = exactStore.claimDueJobs({ now: '2026-07-01T08:00:00.000Z' })
      expect(exactClaim).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            job: expect.objectContaining({ jobId: exact.jobId }),
            jobRun: expect.objectContaining({ triggeredBy: 'schedule' }),
          }),
        ])
      )
    } finally {
      exactStore.close()
    }

    const midMinuteStore = createInMemoryJobsStore()
    try {
      const midMinute = createScheduledJob(midMinuteStore, {}, 'mid-minute').job

      const midMinuteClaim = midMinuteStore.claimDueJobs({ now: '2026-07-01T08:00:30.000Z' })
      expect(midMinuteClaim).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            job: expect.objectContaining({ jobId: midMinute.jobId }),
            jobRun: expect.objectContaining({ triggeredBy: 'schedule' }),
          }),
        ])
      )
    } finally {
      midMinuteStore.close()
    }

    const staleStore = createInMemoryJobsStore()
    try {
      const stale = createScheduledJob(staleStore, {}, 'genuinely-stale').job

      const staleClaim = staleStore.claimDueJobs({ now: '2026-07-01T08:02:00.000Z' })
      expect(staleClaim).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            job: expect.objectContaining({ jobId: stale.jobId }),
            jobRun: expect.objectContaining({ triggeredBy: 'catch-up' }),
          }),
        ])
      )
    } finally {
      staleStore.close()
    }
  })
})
