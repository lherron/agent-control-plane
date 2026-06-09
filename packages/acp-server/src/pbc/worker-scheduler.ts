import type { AcpStateStore, PbcContinuationJob } from 'acp-state-store'

const DEFAULT_LEASE_MS = 5 * 60 * 1000
const DEFAULT_LEASE_OWNER = 'pbc-continuation-worker-scheduler'

export type PbcWorkerScheduler = {
  tick(): Promise<void>
}

export type PbcWorkerSchedulerOptions = {
  stateStore: AcpStateStore
  runWorker(job: PbcContinuationJob): Promise<void>
  leaseOwner?: string | undefined
  leaseMs?: number | undefined
}

export function createPbcWorkerScheduler(
  options: PbcWorkerSchedulerOptions
): PbcWorkerScheduler {
  const leaseOwner = options.leaseOwner ?? DEFAULT_LEASE_OWNER
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS

  return {
    async tick(): Promise<void> {
      const queuedJobs = options.stateStore.pbcContinuationJobs.listByStatus('queued')

      for (const job of queuedJobs) {
        const lease = options.stateStore.pbcContinuationJobs.acquireLease({
          jobId: job.jobId,
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        })

        if (!lease.acquired) {
          continue
        }

        try {
          await options.runWorker(lease.job)
        } catch (error) {
          console.error(
            'pbc continuation worker failed:',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    },
  }
}
