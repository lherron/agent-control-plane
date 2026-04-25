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

  expect(Object.keys(moduleExports)).toEqual(expect.arrayContaining(['tickJobsScheduler']))
  return async () => []
}

describe('scheduler catch-up policy', () => {
  test('emits exactly one catch-up run after downtime, then skips to the next fire window', async () => {
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
          input: { content: 'catch up once after downtime' },
          disabled: false,
          createdAt: '2026-04-23T12:00:00.000Z',
        })
      )) as Record<string, unknown>
      const job = (created['job'] as Record<string, unknown> | undefined) ?? created

      const afterDowntime = await tick({ store, now: '2026-04-23T12:20:00.000Z' })
      expect(afterDowntime).toHaveLength(1)
      expect(afterDowntime[0]).toEqual(
        expect.objectContaining({
          jobId: job['jobId'],
          triggeredBy: 'catch-up',
          status: 'claimed',
        })
      )

      const sameWindowRetry = await tick({ store, now: '2026-04-23T12:20:00.000Z' })
      expect(sameWindowRetry).toHaveLength(0)

      const nextWindow = await tick({ store, now: '2026-04-23T12:25:00.000Z' })
      expect(nextWindow).toHaveLength(1)
      expect(nextWindow[0]).toEqual(
        expect.objectContaining({
          jobId: job['jobId'],
          triggeredBy: 'schedule',
          status: 'claimed',
        })
      )
    } finally {
      ;(store as { close(): void }).close()
    }
  })
})
