import { describe, expect, test } from 'bun:test'

import * as jobsStoreModule from '../index.js'

function resolveJobsCrud(store: Record<string, unknown>): {
  create: (input: Record<string, unknown>) => unknown
} {
  const nested =
    typeof store['jobs'] === 'object' && store['jobs'] !== null
      ? (store['jobs'] as Record<string, unknown>)
      : undefined
  const create =
    store['createJob'] ?? nested?.['create'] ?? nested?.['createJob'] ?? nested?.['insert']

  expect(typeof create).toBe('function')
  return { create: create as (input: Record<string, unknown>) => unknown }
}

function resolveTick(
  moduleExports: Record<string, unknown>,
  store: Record<string, unknown>
): (input: { store: unknown; now: string }) => Promise<Record<string, unknown>[]> {
  const rootTick =
    moduleExports['tickJobsScheduler'] ??
    moduleExports['tickScheduler'] ??
    moduleExports['schedulerTick']
  if (typeof rootTick === 'function') {
    return async (input) =>
      (await Promise.resolve(
        (rootTick as (input: { store: unknown; now: string }) => unknown)(input)
      )) as Record<string, unknown>[]
  }

  const createScheduler =
    moduleExports['createJobsScheduler'] ??
    moduleExports['createScheduler'] ??
    store['createScheduler']
  if (typeof createScheduler === 'function') {
    return async (input) => {
      const scheduler = (await Promise.resolve(
        (createScheduler as (input: { store: unknown }) => unknown)({ store: input.store })
      )) as Record<string, unknown>
      expect(typeof scheduler['tick']).toBe('function')
      return (await Promise.resolve(
        (scheduler['tick'] as (now: string) => unknown)(input.now)
      )) as Record<string, unknown>[]
    }
  }

  if (typeof store['tick'] === 'function') {
    return async (input) =>
      (await Promise.resolve((store['tick'] as (now: string) => unknown)(input.now))) as Record<
        string,
        unknown
      >[]
  }

  expect(Object.keys(moduleExports)).toEqual(expect.arrayContaining(['tickJobsScheduler']))
  return async () => []
}

describe('scheduler tick contract', () => {
  test('claims due runs exactly once per period and is idempotent at a fixed clock instant', async () => {
    const store = jobsStoreModule.createInMemoryJobsStore() as unknown as Record<string, unknown>

    try {
      const jobs = resolveJobsCrud(store)
      const tick = resolveTick(jobsStoreModule as unknown as Record<string, unknown>, store)

      const created = (await Promise.resolve(
        jobs.create({
          agentId: 'larry',
          projectId: 'demo-project',
          scopeRef: 'agent:larry:project:demo-project:task:T-01175:role:implementer',
          laneRef: 'main',
          schedule: { cron: '*/5 * * * *' },
          input: { content: 'wake the implementer' },
          disabled: false,
          createdAt: '2026-04-23T12:00:00.000Z',
        })
      )) as Record<string, unknown>
      const job = (created['job'] as Record<string, unknown> | undefined) ?? created

      const firstTick = await tick({ store, now: '2026-04-23T12:05:00.000Z' })
      expect(firstTick).toHaveLength(1)
      expect(firstTick[0]).toEqual(
        expect.objectContaining({
          jobId: job['jobId'],
          triggeredBy: 'schedule',
          status: 'claimed',
        })
      )

      const secondTick = await tick({ store, now: '2026-04-23T12:05:00.000Z' })
      expect(secondTick).toHaveLength(0)

      const nextPeriodTick = await tick({ store, now: '2026-04-23T12:10:00.000Z' })
      expect(nextPeriodTick).toHaveLength(1)
      expect(nextPeriodTick[0]).toEqual(
        expect.objectContaining({
          jobId: job['jobId'],
          triggeredBy: 'schedule',
          status: 'claimed',
        })
      )
      expect(nextPeriodTick[0]?.['jobRunId']).not.toBe(firstTick[0]?.['jobRunId'])
    } finally {
      ;(store as { close(): void }).close()
    }
  })

  test('claims minute-zero hourly jobs at the current hour boundary', async () => {
    const store = jobsStoreModule.createInMemoryJobsStore() as unknown as Record<string, unknown>

    try {
      const jobs = resolveJobsCrud(store)
      const tick = resolveTick(jobsStoreModule as unknown as Record<string, unknown>, store)

      const created = (await Promise.resolve(
        jobs.create({
          agentId: 'larry',
          projectId: 'demo-project',
          scopeRef: 'agent:larry:project:demo-project:task:T-01254:role:implementer',
          laneRef: 'main',
          schedule: { cron: '0 * * * *' },
          input: { content: 'hourly wake' },
          disabled: false,
          createdAt: '2026-04-25T12:30:00.000Z',
        })
      )) as Record<string, unknown>
      const job = (created['job'] as Record<string, unknown> | undefined) ?? created

      const beforeBoundary = await tick({ store, now: '2026-04-25T12:59:00.000Z' })
      expect(beforeBoundary).toHaveLength(0)

      const hourBoundary = await tick({ store, now: '2026-04-25T13:00:00.000Z' })
      expect(hourBoundary).toHaveLength(1)
      expect(hourBoundary[0]).toEqual(
        expect.objectContaining({
          jobId: job['jobId'],
          triggeredBy: 'schedule',
          status: 'claimed',
        })
      )

      const sameBoundaryRetry = await tick({ store, now: '2026-04-25T13:00:00.000Z' })
      expect(sameBoundaryRetry).toHaveLength(0)
    } finally {
      ;(store as { close(): void }).close()
    }
  })
})
