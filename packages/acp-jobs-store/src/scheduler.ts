import type {
  ClaimDueJobsInput,
  ClaimedDueJob,
  EventJobSkipReason,
  InboxEventRecord,
  JobRecord,
  JobRunRecord,
  JobsStore,
} from './open-store.js'

export type DispatchThroughInputs = (input: {
  jobId: string
  jobRunId: string
  scopeRef: string
  laneRef: string
  content: string
}) => Promise<{ inputAttemptId: string; runId: string }>

export type AdvanceFlowJobRun = (entry: ClaimedDueJob) => Promise<JobRunRecord>

/**
 * Pure decision for a single (event, job) pair. The evaluator performs match /
 * origin-policy / template resolution and returns either a skip with a reason or
 * a mint plan with the RESOLVED action snapshot + source provenance. Cooldown is
 * a store-backed backstop applied by the scheduler (it needs prior-mint state).
 */
export type EventJobEvaluation =
  | { decision: 'skip'; reason: EventJobSkipReason }
  | {
      decision: 'mint'
      resolved: { scopeRef: string; laneRef: string; input: Readonly<Record<string, unknown>> }
      source: Readonly<Record<string, unknown>>
      targetTaskId?: string | undefined
      cooldownMs?: number | undefined
    }

export type EvaluateEventJob = (input: {
  job: JobRecord
  event: InboxEventRecord
}) => EventJobEvaluation

export type TickJobsSchedulerInput = {
  store: JobsStore
  now: string | Date
  dispatchThroughInputs?: DispatchThroughInputs | undefined
  advanceFlowJobRun?: AdvanceFlowJobRun | undefined
  evaluateEventJob?: EvaluateEventJob | undefined
  claimLimit?: number | undefined
  leaseOwner?: string | undefined
  eventLeaseMs?: number | undefined
  maxJobRunDurationMs?: number | undefined
}

export type ScheduledRun = JobRunRecord

const DEFAULT_EVENT_LEASE_MS = 30_000
const DEFAULT_FLOW_LEASE_MS = 30 * 60_000
const DEFAULT_MAX_JOB_RUN_DURATION_MS = 24 * 60 * 60_000
const JOB_CHANGE_ORPHAN_GRACE_MS = 60_000
/** Default page size for the event-inbox drain claim. */
const DEFAULT_EVENT_CLAIM_LIMIT = 50

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/**
 * Effective dispatch context: event (webhook) runs carry a resolved snapshot on
 * the JobRun; schedule/manual runs fall back to the live job fields. The dispatch
 * tail is wrkq-agnostic — it never reads templated job fields for event runs.
 */
function resolveDispatchContext(entry: ClaimedDueJob): {
  scopeRef: string
  laneRef: string
  content: string | undefined
} {
  const resolvedInput = entry.jobRun.resolvedInput
  const snapshotContent =
    resolvedInput !== undefined && typeof resolvedInput['content'] === 'string'
      ? (resolvedInput['content'] as string)
      : undefined
  const liveContent = entry.job.input['content']
  return {
    scopeRef: entry.jobRun.resolvedScopeRef ?? entry.job.scopeRef,
    laneRef: entry.jobRun.resolvedLaneRef ?? entry.job.laneRef,
    content: snapshotContent ?? (typeof liveContent === 'string' ? liveContent : undefined),
  }
}

function isClaimedLeaseExpired(jobRun: JobRunRecord, now: string): boolean {
  return (
    jobRun.status === 'claimed' &&
    (jobRun.leaseExpiresAt === undefined || jobRun.leaseExpiresAt <= now)
  )
}

function hasExceededMaxDuration(
  jobRun: JobRunRecord,
  now: string,
  maxJobRunDurationMs: number
): boolean {
  return hasRunAgeAtLeast(jobRun, now, maxJobRunDurationMs)
}

function hasRunAgeAtLeast(jobRun: JobRunRecord, now: string, durationMs: number): boolean {
  const startedAt = Date.parse(jobRun.triggeredAt)
  const nowMs = Date.parse(now)
  return Number.isFinite(startedAt) && Number.isFinite(nowMs) && nowMs - startedAt >= durationMs
}

function terminalizeInflightJobRuns(input: {
  store: JobsStore
  now: string
  limit?: number | undefined
  maxJobRunDurationMs: number
}): JobRunRecord[] {
  const inflight = input.store.listJobRunReaperCandidates({
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    now: input.now,
  })
  const finalized: JobRunRecord[] = []

  for (const entry of inflight) {
    let errorCode: string | undefined
    let errorMessage: string | undefined

    if (entry.job.flow === undefined && isClaimedLeaseExpired(entry.jobRun, input.now)) {
      errorCode = 'stale_claimed_non_flow'
      errorMessage = 'stale claimed non-flow job run'
    } else if (isOrphanedByJobChange(entry, input.now)) {
      errorCode = 'orphaned_by_job_change'
      errorMessage = 'job run orphaned by job archive, disable, or flow removal'
    } else if (hasExceededMaxDuration(entry.jobRun, input.now, input.maxJobRunDurationMs)) {
      errorCode = 'job_run_max_duration_exceeded'
      errorMessage = 'job run exceeded maximum duration'
    }

    if (errorCode === undefined) {
      continue
    }

    finalized.push(
      input.store.updateJobRun(entry.jobRun.jobRunId, {
        status: 'failed',
        errorCode,
        errorMessage,
        completedAt: input.now,
        leaseOwner: null,
        leaseExpiresAt: null,
      }).jobRun
    )
  }

  return finalized
}

function isOrphanedByJobChange(entry: ClaimedDueJob, now: string): boolean {
  return (
    entry.jobRun.status === 'dispatched' &&
    (entry.job.archivedAt !== undefined || entry.job.disabled || entry.job.flow === undefined) &&
    hasRunAgeAtLeast(entry.jobRun, now, JOB_CHANGE_ORPHAN_GRACE_MS)
  )
}

/**
 * Event-claim branch: drain the inbox by event_seq, evaluate every active
 * event-trigger job against each event, and idempotently mint JobRuns with a
 * resolved snapshot. Records an outcome row for EVERY (event, job) pair (no
 * silent skips). A per-job failure is isolated (recorded, never poisons the
 * event for other jobs); the event is marked processed once all jobs are seen.
 */
function drainEventInbox(input: {
  store: JobsStore
  now: string
  evaluateEventJob: EvaluateEventJob
  leaseOwner: string
  leaseMs: number
  limit: number
}): ClaimedDueJob[] {
  const { store, now } = input
  const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString()
  const events = store.claimPendingInboxEvents({
    now,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt,
    limit: input.limit,
  })

  const minted: ClaimedDueJob[] = []
  for (const event of events) {
    try {
      const jobs = store.listActiveEventJobs().jobs
      for (const job of jobs) {
        // Per-(event,job) idempotency: skip pairs already recorded (drain-retry).
        if (store.getEventJobMatch(event.eventId, job.jobId).match !== undefined) {
          continue
        }
        try {
          const evaluation = input.evaluateEventJob({ job, event })
          if (evaluation.decision === 'skip') {
            store.recordEventJobSkip({
              sourceEventId: event.eventId,
              jobId: job.jobId,
              eventSeq: event.eventSeq,
              reason: evaluation.reason,
            })
            continue
          }

          if (
            evaluation.cooldownMs !== undefined &&
            evaluation.cooldownMs > 0 &&
            evaluation.targetTaskId !== undefined
          ) {
            const sinceIso = new Date(Date.parse(now) - evaluation.cooldownMs).toISOString()
            if (store.hasRecentMint(job.jobId, evaluation.targetTaskId, sinceIso)) {
              store.recordEventJobSkip({
                sourceEventId: event.eventId,
                jobId: job.jobId,
                eventSeq: event.eventSeq,
                reason: 'cooldown',
                ...(evaluation.targetTaskId !== undefined
                  ? { targetTaskId: evaluation.targetTaskId }
                  : {}),
              })
              continue
            }
          }

          const mint = store.mintEventJobRun({
            sourceEventId: event.eventId,
            eventSeq: event.eventSeq,
            jobId: job.jobId,
            resolvedScopeRef: evaluation.resolved.scopeRef,
            resolvedLaneRef: evaluation.resolved.laneRef,
            resolvedInput: evaluation.resolved.input,
            source: evaluation.source,
            ...(evaluation.targetTaskId !== undefined
              ? { targetTaskId: evaluation.targetTaskId }
              : {}),
            triggeredAt: now,
          })
          if (mint.minted) {
            minted.push({ job, jobRun: mint.jobRun })
          }
        } catch (_error) {
          // Per-job isolation: an unexpected evaluation/mint failure for one job
          // is recorded (closest reason: template_error) and never poisons the
          // event for the remaining jobs.
          store.recordEventJobSkip({
            sourceEventId: event.eventId,
            jobId: job.jobId,
            eventSeq: event.eventSeq,
            reason: 'template_error',
          })
        }
      }
      store.markInboxEventProcessed(event.eventId, now)
    } catch (error) {
      store.markInboxEventFailed(
        event.eventId,
        error instanceof Error ? error.message : String(error),
        now
      )
    }
  }

  return minted
}

export async function tickJobsScheduler(input: TickJobsSchedulerInput): Promise<ScheduledRun[]> {
  const now = toIsoString(input.now)
  const leaseOwner = input.leaseOwner ?? 'acp-scheduler'
  const flowLeaseExpiresAt = new Date(Date.parse(now) + DEFAULT_FLOW_LEASE_MS).toISOString()
  const claimed = input.store.claimDueJobs({
    now,
    ...(input.claimLimit !== undefined ? { limit: input.claimLimit } : {}),
    leaseOwner,
    leaseExpiresAt: flowLeaseExpiresAt,
  } satisfies ClaimDueJobsInput)

  // Event-claim sibling branch: drain webhook events and mint event JobRuns.
  const mintedEventRuns =
    input.evaluateEventJob !== undefined
      ? drainEventInbox({
          store: input.store,
          now,
          evaluateEventJob: input.evaluateEventJob,
          leaseOwner: input.leaseOwner ?? 'acp-scheduler',
          leaseMs: input.eventLeaseMs ?? DEFAULT_EVENT_LEASE_MS,
          limit: input.claimLimit ?? DEFAULT_EVENT_CLAIM_LIMIT,
        })
      : []

  const allClaimed = [...claimed, ...mintedEventRuns]
  const scheduledRuns = allClaimed.map((entry) => entry.jobRun)
  const reapedRuns = terminalizeInflightJobRuns({
    store: input.store,
    now,
    ...(input.claimLimit !== undefined ? { limit: input.claimLimit } : {}),
    maxJobRunDurationMs: input.maxJobRunDurationMs ?? DEFAULT_MAX_JOB_RUN_DURATION_MS,
  })
  if (input.dispatchThroughInputs === undefined && input.advanceFlowJobRun === undefined) {
    return [...scheduledRuns, ...reapedRuns]
  }

  const results: ScheduledRun[] = [...reapedRuns]
  for (const entry of allClaimed) {
    if (entry.job.flow !== undefined) {
      if (input.advanceFlowJobRun === undefined) {
        results.push(entry.jobRun)
        continue
      }

      try {
        results.push(await input.advanceFlowJobRun(entry))
      } catch (error) {
        results.push(
          input.store.updateJobRun(entry.jobRun.jobRunId, {
            status: 'failed',
            errorCode: 'flow_advance_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            completedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          }).jobRun
        )
      }
      continue
    }

    if (input.dispatchThroughInputs === undefined) {
      results.push(entry.jobRun)
      continue
    }

    try {
      const context = resolveDispatchContext(entry)
      if (typeof context.content !== 'string' || context.content.trim().length === 0) {
        throw new Error(`job input.content must be a non-empty string for ${entry.job.jobId}`)
      }

      const dispatch = await input.dispatchThroughInputs({
        jobId: entry.job.jobId,
        jobRunId: entry.jobRun.jobRunId,
        scopeRef: context.scopeRef,
        laneRef: context.laneRef,
        content: context.content.trim(),
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

  if (input.advanceFlowJobRun !== undefined) {
    const inflight = input.store.listInflightFlowJobRuns({
      ...(input.claimLimit !== undefined ? { limit: input.claimLimit } : {}),
      now,
    })
    const claimedIds = new Set(allClaimed.map((entry) => entry.jobRun.jobRunId))
    for (const entry of inflight) {
      if (claimedIds.has(entry.jobRun.jobRunId)) {
        continue
      }

      try {
        results.push(await input.advanceFlowJobRun(entry))
      } catch (error) {
        results.push(
          input.store.updateJobRun(entry.jobRun.jobRunId, {
            status: 'failed',
            errorCode: 'flow_advance_failed',
            errorMessage: error instanceof Error ? error.message : String(error),
            completedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          }).jobRun
        )
      }
    }
  }

  return results
}

export function createJobsScheduler(input: {
  store: JobsStore
  dispatchThroughInputs?: DispatchThroughInputs | undefined
  advanceFlowJobRun?: AdvanceFlowJobRun | undefined
  evaluateEventJob?: EvaluateEventJob | undefined
}) {
  return {
    tick(now: string | Date): Promise<ScheduledRun[]> {
      return tickJobsScheduler({
        store: input.store,
        now,
        ...(input.dispatchThroughInputs !== undefined
          ? { dispatchThroughInputs: input.dispatchThroughInputs }
          : {}),
        ...(input.advanceFlowJobRun !== undefined
          ? { advanceFlowJobRun: input.advanceFlowJobRun }
          : {}),
        ...(input.evaluateEventJob !== undefined
          ? { evaluateEventJob: input.evaluateEventJob }
          : {}),
      })
    },
  }
}
