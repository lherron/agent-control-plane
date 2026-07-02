import { describe, expect, test } from 'bun:test'

import {
  type ClaimedDueJob,
  type JobRunRecord,
  type JobsStore,
  createInMemoryJobsStore,
  tickJobsScheduler,
} from '../index.js'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function createDueFlowJob(store: JobsStore, slug: string) {
  return store.createJob({
    slug,
    agentId: 'larry',
    projectId: 'demo',
    scopeRef: `agent:larry:project:demo:task:T-05420:${slug}`,
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'unused flow input' },
    flow: {
      sequence: [{ id: 'exec', input: 'run a slow step', expect: { outcome: 'succeeded' } }],
    },
    disabled: false,
    createdAt: '2026-04-28T00:00:00.000Z',
  }).job
}

function createInflightFlowRun(
  store: JobsStore,
  input: { slug: string; jobRunId: string; triggeredAt: string }
) {
  const job = store.createJob({
    slug: input.slug,
    agentId: 'larry',
    projectId: 'demo',
    scopeRef: `agent:larry:project:demo:task:T-05420:${input.slug}`,
    laneRef: 'main',
    schedule: { cron: '0 4 * * 1' },
    input: { content: 'unused flow input' },
    flow: {
      sequence: [{ id: 'exec', input: 'continue flow', expect: { outcome: 'succeeded' } }],
    },
    disabled: false,
    createdAt: '2026-04-28T00:00:00.000Z',
  }).job
  return store.appendJobRun({
    jobId: job.jobId,
    jobRunId: input.jobRunId,
    triggeredAt: input.triggeredAt,
    triggeredBy: 'manual',
    status: 'dispatched',
    dispatchedAt: input.triggeredAt,
    actor: { kind: 'system', id: 'test' },
    actorStamp: 'system:test',
  }).jobRun
}

async function flushSchedulerStarts(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function succeedRun(store: JobsStore, entry: ClaimedDueJob, now: string): JobRunRecord {
  return store.updateJobRun(entry.jobRun.jobRunId, {
    status: 'succeeded',
    completedAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
  }).jobRun
}

describe('flow scheduler advance concurrency (T-05420 red)', () => {
  test('a slow due flow advance does not head-of-line block an unrelated due flow job', async () => {
    const store = createInMemoryJobsStore()

    try {
      createDueFlowJob(store, 'slow-due-flow')
      createDueFlowJob(store, 'unrelated-due-flow')

      const slowEntered = deferred()
      const releaseSlow = deferred()
      const entered: string[] = []
      let slowJobRunId: string | undefined

      const tick = tickJobsScheduler({
        store,
        now: '2026-04-28T00:05:00.000Z',
        // T-05420 red: this hook models a long inline exec/advance. The
        // unrelated due flow must be started before this promise resolves.
        advanceFlowJobRun: async (entry) => {
          entered.push(entry.jobRun.jobRunId)
          if (slowJobRunId === undefined) {
            slowJobRunId = entry.jobRun.jobRunId
            slowEntered.resolve()
            await releaseSlow.promise
          }
          return succeedRun(store, entry, '2026-04-28T00:05:00.000Z')
        },
      })

      await slowEntered.promise
      await flushSchedulerStarts()

      try {
        expect(entered.length).toBe(2)
        expect(entered).toContain(slowJobRunId)
      } finally {
        releaseSlow.resolve()
        await tick
      }
    } finally {
      store.close()
    }
  })

  test('independent in-flight flow advances overlap up to the configured concurrency cap', async () => {
    const store = createInMemoryJobsStore()

    try {
      createInflightFlowRun(store, {
        slug: 'inflight-one',
        jobRunId: 'jrun_concurrency_1',
        triggeredAt: '2026-04-28T00:00:01.000Z',
      })
      createInflightFlowRun(store, {
        slug: 'inflight-two',
        jobRunId: 'jrun_concurrency_2',
        triggeredAt: '2026-04-28T00:00:02.000Z',
      })
      createInflightFlowRun(store, {
        slug: 'inflight-three',
        jobRunId: 'jrun_concurrency_3',
        triggeredAt: '2026-04-28T00:00:03.000Z',
      })

      const releaseFirstWave = deferred()
      const entered: string[] = []
      const completed: string[] = []

      const tick = tickJobsScheduler({
        store,
        now: '2026-04-28T00:05:00.000Z',
        // T-05420 red: cap=2 should start two independent advances before
        // either completes, while holding the third until a slot is released.
        flowAdvanceConcurrency: 2,
        advanceFlowJobRun: async (entry) => {
          entered.push(entry.jobRun.jobRunId)
          if (entered.length <= 2) {
            await releaseFirstWave.promise
          }
          completed.push(entry.jobRun.jobRunId)
          return succeedRun(store, entry, '2026-04-28T00:05:00.000Z')
        },
      } as Parameters<typeof tickJobsScheduler>[0] & { flowAdvanceConcurrency: number })

      await flushSchedulerStarts()

      try {
        expect(entered).toEqual(['jrun_concurrency_1', 'jrun_concurrency_2'])
        expect(completed).toEqual([])
      } finally {
        releaseFirstWave.resolve()
        await tick
      }

      expect(entered).toEqual(['jrun_concurrency_1', 'jrun_concurrency_2', 'jrun_concurrency_3'])
    } finally {
      store.close()
    }
  })

  test('a slow failing flow advance is isolated from sibling flow advances', async () => {
    const store = createInMemoryJobsStore()

    try {
      createInflightFlowRun(store, {
        slug: 'failing-inflight',
        jobRunId: 'jrun_isolated_failure',
        triggeredAt: '2026-04-28T00:00:01.000Z',
      })
      createInflightFlowRun(store, {
        slug: 'sibling-inflight',
        jobRunId: 'jrun_isolated_sibling',
        triggeredAt: '2026-04-28T00:00:02.000Z',
      })

      const failingEntered = deferred()
      const rejectFailing = deferred()
      const entered: string[] = []

      const tick = tickJobsScheduler({
        store,
        now: '2026-04-28T00:05:00.000Z',
        // T-05420 red: per-run isolation must not wait for the failing
        // advance to settle before starting an unrelated sibling run.
        advanceFlowJobRun: async (entry) => {
          entered.push(entry.jobRun.jobRunId)
          if (entry.jobRun.jobRunId === 'jrun_isolated_failure') {
            failingEntered.resolve()
            await rejectFailing.promise
            throw new Error('simulated slow flow advance failure')
          }
          return succeedRun(store, entry, '2026-04-28T00:05:00.000Z')
        },
      })

      await failingEntered.promise
      await flushSchedulerStarts()

      try {
        expect(entered).toEqual(['jrun_isolated_failure', 'jrun_isolated_sibling'])
      } finally {
        rejectFailing.resolve()
        await tick
      }

      expect(store.getJobRun('jrun_isolated_failure').jobRun).toMatchObject({
        status: 'failed',
        errorCode: 'flow_advance_failed',
      })
      expect(store.getJobRun('jrun_isolated_sibling').jobRun).toMatchObject({
        status: 'succeeded',
        completedAt: '2026-04-28T00:05:00.000Z',
      })
    } finally {
      store.close()
    }
  })
})
