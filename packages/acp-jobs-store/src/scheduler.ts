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
  causationRef?: string | undefined
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
  store: JobsStore
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
  flowAdvanceConcurrency?: number | undefined
  executionIdentity?:
    | Readonly<{ nodeId: string; mode: 'single-node' | 'federated'; verifiedAt: string }>
    | undefined
}

export type ScheduledRun = JobRunRecord

const DEFAULT_EVENT_LEASE_MS = 30_000
const DEFAULT_FLOW_LEASE_MS = 30 * 60_000
const DEFAULT_MAX_JOB_RUN_DURATION_MS = 24 * 60 * 60_000
const JOB_CHANGE_ORPHAN_GRACE_MS = 60_000
/** Default page size for the event-inbox drain claim. */
const DEFAULT_EVENT_CLAIM_LIMIT = 50
const DEFAULT_FLOW_ADVANCE_CONCURRENCY = 4
const MAX_FLOW_ADVANCE_CONCURRENCY = 32
const DEFAULT_FLOW_ADVANCE_MAX_RETRIES = 3
const DEFAULT_FLOW_ADVANCE_RETRY_DELAY_MS = 60_000

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

function resolveFlowAdvanceConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_FLOW_ADVANCE_CONCURRENCY
  }

  return Math.max(1, Math.min(MAX_FLOW_ADVANCE_CONCURRENCY, Math.floor(value)))
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
          const evaluation = input.evaluateEventJob({ job, event, store })
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
          // is recorded and never poisons the event for the remaining jobs.
          store.recordEventJobSkip({
            sourceEventId: event.eventId,
            jobId: job.jobId,
            eventSeq: event.eventSeq,
            reason: 'internal_error',
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
  const flowAdvanceEntries: ClaimedDueJob[] = []
  if (input.advanceFlowJobRun !== undefined) {
    for (const entry of allClaimed) {
      if (entry.job.flow !== undefined) {
        flowAdvanceEntries.push(entry)
      }
    }

    const inflight = input.store.listInflightFlowJobRuns({
      ...(input.claimLimit !== undefined ? { limit: input.claimLimit } : {}),
      now,
    })
    const claimedIds = new Set(allClaimed.map((entry) => entry.jobRun.jobRunId))
    for (const entry of inflight) {
      if (!claimedIds.has(entry.jobRun.jobRunId)) {
        flowAdvanceEntries.push(entry)
      }
    }
  }

  // Flow advances can execute long-running native steps. Start them in a bounded
  // pool before ordinary dispatch work so one slow flow cannot head-of-line
  // block independent due runs in the same tick.
  const flowAdvanceResults =
    input.advanceFlowJobRun !== undefined
      ? advanceFlowJobRuns({
          store: input.store,
          entries: flowAdvanceEntries,
          advanceFlowJobRun: input.advanceFlowJobRun,
          now,
          concurrency: resolveFlowAdvanceConcurrency(input.flowAdvanceConcurrency),
        })
      : Promise.resolve([])

  for (const entry of allClaimed) {
    if (entry.job.flow !== undefined) {
      if (input.advanceFlowJobRun === undefined) {
        results.push(entry.jobRun)
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
        ...(entry.jobRun.triggeredBy === 'webhook' ? { causationRef: entry.jobRun.jobRunId } : {}),
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
    results.push(...(await flowAdvanceResults))
  }

  return results
}

async function advanceFlowJobRuns(input: {
  store: JobsStore
  entries: ClaimedDueJob[]
  advanceFlowJobRun: AdvanceFlowJobRun
  now: string
  concurrency: number
}): Promise<ScheduledRun[]> {
  const results = new Array<ScheduledRun>(input.entries.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= input.entries.length) {
        return
      }

      const entry = input.entries[index]
      if (entry === undefined) {
        continue
      }

      try {
        results[index] = clearFlowRetryMetadata(input.store, await input.advanceFlowJobRun(entry))
      } catch (error) {
        results[index] = handleFlowAdvanceError({
          store: input.store,
          entry,
          error,
          now: input.now,
        })
      }
    }
  }

  const workerCount = Math.min(input.concurrency, input.entries.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function handleFlowAdvanceError(input: {
  store: JobsStore
  entry: ClaimedDueJob
  error: unknown
  now: string
}): JobRunRecord {
  const message = errorMessage(input.error)
  if (!isTransientFlowAdvanceError(input.error)) {
    return input.store.updateJobRun(input.entry.jobRun.jobRunId, {
      status: 'failed',
      errorCode: 'flow_advance_failed',
      errorMessage: message,
      completedAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAttempts: null,
      nextAttemptAt: null,
      lastRetryError: null,
    }).jobRun
  }

  const retryAttempts = (input.entry.jobRun.retryAttempts ?? 0) + 1
  if (retryAttempts >= DEFAULT_FLOW_ADVANCE_MAX_RETRIES) {
    return input.store.updateJobRun(input.entry.jobRun.jobRunId, {
      status: 'failed',
      errorCode: 'transient_flow_advance_exhausted',
      errorMessage: message,
      completedAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      retryAttempts,
      nextAttemptAt: null,
      lastRetryError: message,
    }).jobRun
  }

  const nextAttemptAt = new Date(
    Date.parse(input.now) + DEFAULT_FLOW_ADVANCE_RETRY_DELAY_MS
  ).toISOString()
  return input.store.updateJobRun(input.entry.jobRun.jobRunId, {
    status: input.entry.jobRun.status === 'dispatched' ? 'dispatched' : 'claimed',
    errorCode: 'retry_transient_flow_advance',
    errorMessage: message,
    completedAt: undefined,
    leaseOwner: input.entry.jobRun.leaseOwner ?? 'acp-scheduler',
    leaseExpiresAt: nextAttemptAt,
    retryAttempts,
    nextAttemptAt,
    lastRetryError: message,
  }).jobRun
}

function clearFlowRetryMetadata(store: JobsStore, jobRun: JobRunRecord): JobRunRecord {
  if (
    jobRun.retryAttempts === undefined &&
    jobRun.nextAttemptAt === undefined &&
    jobRun.lastRetryError === undefined
  ) {
    return jobRun
  }

  const cleared = store.updateJobRun(jobRun.jobRunId, {
    ...(jobRun.errorCode === 'retry_transient_flow_advance'
      ? { errorCode: null, errorMessage: null }
      : {}),
    retryAttempts: null,
    nextAttemptAt: null,
    lastRetryError: null,
  }).jobRun
  return jobRun.errorCode === 'retry_transient_flow_advance'
    ? { ...cleared, errorCode: undefined }
    : cleared
}

function isTransientFlowAdvanceError(error: unknown): boolean {
  const code = errorCode(error)
  if (
    code === 'job_run_max_duration_exceeded' ||
    code === 'orphaned_by_job_change' ||
    code === 'stale_claimed_non_flow' ||
    code === 'agent_step_timeout'
  ) {
    return false
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'hrc_unavailable' ||
    code === 'dispatch_failed'
  ) {
    return true
  }

  const status = errorStatus(error)
  if (status !== undefined && status >= 500 && status <= 599) {
    return true
  }

  const message = errorMessage(error).toLowerCase()
  if (
    message.includes('invalid job flow') ||
    message.includes('expectation') ||
    message.includes('unsupported flow step kind') ||
    message.includes('flow transition target not found') ||
    message.includes('flow step not found')
  ) {
    return false
  }

  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('hrc unavailable') ||
    message.includes('dispatch gateway returned http 5') ||
    message.includes('http 503') ||
    message.includes('http 502') ||
    message.includes('http 500') ||
    message.includes('hostsessionid is required') ||
    message.includes('runtime already has an active run') ||
    message.includes('different request body already exists for idempotencykey')
  )
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createJobsScheduler(input: {
  store: JobsStore
  dispatchThroughInputs?: DispatchThroughInputs | undefined
  advanceFlowJobRun?: AdvanceFlowJobRun | undefined
  evaluateEventJob?: EvaluateEventJob | undefined
}) {
  return {
    tick(
      now: string | Date,
      executionIdentity?: TickJobsSchedulerInput['executionIdentity']
    ): Promise<ScheduledRun[]> {
      return tickJobsScheduler({
        store: input.store,
        now,
        ...(executionIdentity !== undefined ? { executionIdentity } : {}),
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
