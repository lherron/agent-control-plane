import type { ClaimDueJobsInput, JobRunRecord, JobsStore } from './open-store.js'

export type DispatchThroughInputs = (input: {
  jobId: string
  jobRunId: string
  scopeRef: string
  laneRef: string
  content: string
}) => Promise<{ inputAttemptId: string; runId: string }>

export type TickJobsSchedulerInput = {
  store: JobsStore
  now: string | Date
  dispatchThroughInputs?: DispatchThroughInputs | undefined
  claimLimit?: number | undefined
}

export type ScheduledRun = JobRunRecord

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export async function tickJobsScheduler(input: TickJobsSchedulerInput): Promise<ScheduledRun[]> {
  const now = toIsoString(input.now)
  const claimed = input.store.claimDueJobs({
    now,
    ...(input.claimLimit !== undefined ? { limit: input.claimLimit } : {}),
  } satisfies ClaimDueJobsInput)

  const scheduledRuns = claimed.map((entry) => entry.jobRun)
  if (input.dispatchThroughInputs === undefined) {
    return scheduledRuns
  }

  const results: ScheduledRun[] = []
  for (const entry of claimed) {
    try {
      const content = entry.job.input['content']
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error(`job input.content must be a non-empty string for ${entry.job.jobId}`)
      }

      const dispatch = await input.dispatchThroughInputs({
        jobId: entry.job.jobId,
        jobRunId: entry.jobRun.jobRunId,
        scopeRef: entry.job.scopeRef,
        laneRef: entry.job.laneRef,
        content: content.trim(),
      })
      results.push(
        input.store.updateJobRun(entry.jobRun.jobRunId, {
          status: 'dispatched',
          inputAttemptId: dispatch.inputAttemptId,
          runId: dispatch.runId,
          dispatchedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        }).jobRun
      )
    } catch (error) {
      results.push(
        input.store.updateJobRun(entry.jobRun.jobRunId, {
          status: 'failed',
          errorCode: 'dispatch_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
        }).jobRun
      )
    }
  }

  return results
}

export function createJobsScheduler(input: {
  store: JobsStore
  dispatchThroughInputs?: DispatchThroughInputs | undefined
}) {
  return {
    tick(now: string | Date): Promise<ScheduledRun[]> {
      return tickJobsScheduler({
        store: input.store,
        now,
        ...(input.dispatchThroughInputs !== undefined
          ? { dispatchThroughInputs: input.dispatchThroughInputs }
          : {}),
      })
    },
  }
}
