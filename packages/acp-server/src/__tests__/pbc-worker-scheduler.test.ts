/**
 * RED tests — pbc-worker-scheduler (T-03156)
 *
 * Module under test: src/pbc/worker-scheduler.ts  (NOT YET IMPLEMENTED — all RED)
 *
 * ─── CONTRACT ────────────────────────────────────────────────────────────────
 *
 *   createPbcWorkerScheduler({stateStore, runWorker, leaseOwner?, leaseMs?})
 *     → { tick(): Promise<void> }
 *
 *   tick() behavior:
 *   1. Lists all queued pbc_continuation_jobs from stateStore.pbcContinuationJobs.
 *   2. For each queued job, acquires a lease (job → running) via acquireLease().
 *   3. Calls runWorker(job) for each successfully-leased job.
 *   4. When no queued jobs exist, runWorker is never called.
 *   5. Errors from individual runWorker calls are caught per-job and do NOT abort
 *      the remaining jobs in the same tick.
 *
 *   "Disabled" path: when tick() is never invoked (i.e. the scheduler was never
 *   constructed, or the surrounding setInterval was never started because
 *   ACP_SCHEDULER_ENABLED is false), queued jobs remain queued indefinitely.
 *   This is the existing behavior the tests must protect.
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 *
 *   runPbcContinuationWorker (src/pbc/worker.ts) is fully implemented but has no
 *   caller in the running acp-server. A `queued` pbc_continuation_job admitted by
 *   /v1/pbc/start or /v1/pbc/tasks/:taskId/continue stays queued forever.
 *   The drainer created here wires it into the existing ACP_SCHEDULER_ENABLED
 *   setInterval lifecycle in cli.ts — same guard/teardown pattern.
 *
 * ─── PATTERN ─────────────────────────────────────────────────────────────────
 *
 *   - No live HRC required: runWorker is injected as a stub.
 *   - Real in-memory acp-state-store (openAcpStateStore + ':memory:') provides
 *     accurate lease semantics without SQLite file I/O.
 *   - Each test opens and closes its own store (try/finally).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { type AcpStateStore, type PbcContinuationJob, openAcpStateStore } from 'acp-state-store'

// ─── RED IMPORT ──────────────────────────────────────────────────────────────
// This import will FAIL until src/pbc/worker-scheduler.ts is created.
// Every test in this file is RED for that reason.
import {
  type PbcWorkerScheduler,
  createPbcWorkerScheduler,
} from '../pbc/worker-scheduler.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PBC_WORKFLOW_REF = 'pbc-progressive-refinement@5'

function admitJob(
  store: AcpStateStore,
  opts: { taskId: string; revision?: number; key?: string }
): PbcContinuationJob {
  const { job } = store.pbcContinuationJobs.admit({
    taskId: opts.taskId,
    workflowRef: PBC_WORKFLOW_REF,
    revisionAtAdmission: String(opts.revision ?? 1),
    idempotencyKey: opts.key ?? `key-${opts.taskId}`,
  })
  return job
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('createPbcWorkerScheduler — enabled path (tick called)', () => {
  let store: AcpStateStore

  beforeEach(() => {
    store = openAcpStateStore({ dbPath: ':memory:' })
  })

  afterEach(() => {
    store.close()
  })

  // ── basic: single queued job is picked up and runWorker is called ──────────

  test('tick() invokes runWorker exactly once for a single queued job', async () => {
    const job = admitJob(store, { taskId: 'T-sched-01' })

    const workerCalls: PbcContinuationJob[] = []
    const scheduler: PbcWorkerScheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async (j) => {
        workerCalls.push(j)
      },
    })

    await scheduler.tick()

    expect(workerCalls).toHaveLength(1)
    expect(workerCalls[0]!.jobId).toBe(job.jobId)
    expect(workerCalls[0]!.taskId).toBe('T-sched-01')
  })

  // ── job is leased (running) before runWorker is invoked ───────────────────

  test('job is in running status when runWorker is invoked (lease acquired first)', async () => {
    admitJob(store, { taskId: 'T-sched-02' })

    let statusAtInvocation: string | undefined
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async (job) => {
        const fresh = store.pbcContinuationJobs.get(job.jobId)
        statusAtInvocation = fresh?.status
      },
    })

    await scheduler.tick()

    expect(statusAtInvocation).toBe('running')
  })

  // ── no queued jobs → runWorker is never called ────────────────────────────

  test('tick() does not invoke runWorker when no queued jobs exist', async () => {
    let workerCallCount = 0
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async () => {
        workerCallCount++
      },
    })

    await scheduler.tick()

    expect(workerCallCount).toBe(0)
  })

  // ── multiple queued jobs: all picked up in a single tick ──────────────────

  test('tick() processes all queued jobs in one tick', async () => {
    const job1 = admitJob(store, { taskId: 'T-sched-03a', key: 'k1' })
    const job2 = admitJob(store, { taskId: 'T-sched-03b', key: 'k2' })
    const job3 = admitJob(store, { taskId: 'T-sched-03c', key: 'k3' })

    const processedIds: string[] = []
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async (job) => {
        processedIds.push(job.jobId)
      },
    })

    await scheduler.tick()

    expect(processedIds).toContain(job1.jobId)
    expect(processedIds).toContain(job2.jobId)
    expect(processedIds).toContain(job3.jobId)
    expect(processedIds).toHaveLength(3)
  })

  // ── runWorker error is isolated — other jobs in the same tick still run ───

  test('runWorker error for one job does not abort remaining jobs in the same tick', async () => {
    const failJob = admitJob(store, { taskId: 'T-sched-04a', key: 'fail' })
    const okJob = admitJob(store, { taskId: 'T-sched-04b', key: 'ok' })

    const processedIds: string[] = []
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async (job) => {
        if (job.jobId === failJob.jobId) {
          throw new Error('simulated runWorker failure')
        }
        processedIds.push(job.jobId)
      },
    })

    // Should not throw even if one runWorker call fails
    await expect(scheduler.tick()).resolves.toBeUndefined()

    // The ok job was still processed
    expect(processedIds).toContain(okJob.jobId)
  })

  // ── already-running jobs (non-expired lease) are not re-leased ────────────

  test('tick() does not invoke runWorker for a job that is already running with a live lease', async () => {
    const job = admitJob(store, { taskId: 'T-sched-05' })

    // Manually acquire the lease as if another worker already claimed it
    const farFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    store.pbcContinuationJobs.acquireLease({
      jobId: job.jobId,
      leaseOwner: 'some-other-worker',
      leaseExpiresAt: farFuture,
    })

    let workerCallCount = 0
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async () => {
        workerCallCount++
      },
    })

    await scheduler.tick()

    // Already-running job with live lease: not re-processed
    expect(workerCallCount).toBe(0)
  })

  // ── terminal jobs (succeeded/failed) are skipped ─────────────────────────

  test('tick() does not invoke runWorker for terminal (succeeded) jobs', async () => {
    const job = admitJob(store, { taskId: 'T-sched-06' })

    // Advance the job to a terminal state manually
    const farFuture = new Date(Date.now() + 60_000).toISOString()
    store.pbcContinuationJobs.acquireLease({
      jobId: job.jobId,
      leaseOwner: 'pre-run',
      leaseExpiresAt: farFuture,
    })
    store.pbcContinuationJobs.transition({
      jobId: job.jobId,
      toStatus: 'succeeded',
      stopReason: 'closed',
    })

    let workerCallCount = 0
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async () => {
        workerCallCount++
      },
    })

    await scheduler.tick()

    expect(workerCallCount).toBe(0)
  })

  // ── successive ticks: completed job not re-run on the next tick ───────────

  test('a job completed in one tick is not re-processed in the next tick', async () => {
    admitJob(store, { taskId: 'T-sched-07' })

    let workerCallCount = 0
    const scheduler = createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async (job) => {
        workerCallCount++
        // Simulate the worker finalizing the job (as runPbcContinuationWorker would)
        store.pbcContinuationJobs.transition({
          jobId: job.jobId,
          toStatus: 'succeeded',
          stopReason: 'closed',
        })
      },
    })

    await scheduler.tick()
    await scheduler.tick() // second tick: job is terminal, should be skipped

    expect(workerCallCount).toBe(1) // processed exactly once
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// "Disabled" path: scheduler never created / tick never called
//
// This section proves the invariant: admitted jobs stay `queued` when no tick
// fires. That is the current (broken) behavior that the implementation will FIX.
// The tests here confirm that the *scheduler* (not an env flag) is the only
// mechanism that advances jobs — and absence of a scheduler is safe.
// ─────────────────────────────────────────────────────────────────────────────

describe('createPbcWorkerScheduler — disabled path (no tick)', () => {
  let store: AcpStateStore

  beforeEach(() => {
    store = openAcpStateStore({ dbPath: ':memory:' })
  })

  afterEach(() => {
    store.close()
  })

  test('admitted job stays queued when no scheduler is constructed', () => {
    // Simulates ACP_SCHEDULER_ENABLED=false: stateStore exists, scheduler is never
    // built, setInterval is never started — jobs stay queued forever.
    const job = admitJob(store, { taskId: 'T-sched-disabled-01' })

    const fresh = store.pbcContinuationJobs.get(job.jobId)
    expect(fresh?.status).toBe('queued')
  })

  test('admitted job stays queued when scheduler is built but tick() is never called', async () => {
    // Scheduler created but tick never fired (e.g. interval cleared before first tick).
    const job = admitJob(store, { taskId: 'T-sched-disabled-02' })

    // Build the scheduler — should not auto-start any background work
    createPbcWorkerScheduler({
      stateStore: store,
      runWorker: async () => {
        throw new Error('runWorker must not be called without tick()')
      },
    })

    // No tick() call — job must still be queued
    const fresh = store.pbcContinuationJobs.get(job.jobId)
    expect(fresh?.status).toBe('queued')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Type contract
// ─────────────────────────────────────────────────────────────────────────────

describe('createPbcWorkerScheduler — type contract', () => {
  test('return value satisfies PbcWorkerScheduler structural type', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const scheduler: PbcWorkerScheduler = createPbcWorkerScheduler({
        stateStore: store,
        runWorker: async () => {},
      })
      expect(typeof scheduler.tick).toBe('function')
    } finally {
      store.close()
    }
  })

  test('leaseOwner and leaseMs options are accepted (optional)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      // Compile-time check: both optional params accepted
      const scheduler: PbcWorkerScheduler = createPbcWorkerScheduler({
        stateStore: store,
        runWorker: async () => {},
        leaseOwner: 'test-owner',
        leaseMs: 30_000,
      })
      expect(typeof scheduler.tick).toBe('function')
    } finally {
      store.close()
    }
  })
})
