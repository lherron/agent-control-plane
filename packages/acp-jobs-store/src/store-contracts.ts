import type {
  Actor,
  BranchTaken,
  JobFlow,
  JobStepRunPhase,
  JobStepRunStatus,
  JobTrigger,
} from 'acp-core'
import type { SqliteDatabase } from './sqlite.js'

export type JobsStoreMigration = {
  id: string
  sql: string
}

export type JobRunTrigger = 'schedule' | 'manual' | 'catch-up' | 'webhook'

export type JobRunStatus = 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped'

export type ScheduleJobSkipReason = 'schedule_window' | 'stale_catch_up_suppressed'

export type InboxEventStatus = 'pending' | 'leased' | 'processed' | 'failed'

export type EventJobOutcome = 'minted' | 'skipped'

export type EventJobSkipReason =
  | 'agent_origin_blocked'
  | 'causation_cycle'
  | 'causation_depth'
  | 'cooldown'
  | 'template_error'
  | 'internal_error'
  | 'match_false'

export type JobSchedule = Readonly<{
  cron: string
  windowStart?: string | undefined
  windowEnd?: string | undefined
  windowMinutes?: number | undefined
  catchUp?: 'none' | 'one' | undefined
  timezone?: string | undefined
  [key: string]: unknown
}>

export type JobInputTemplate = Readonly<Record<string, unknown>>

export type JobOutputWebhookSink = Readonly<{
  kind: 'webhook'
  url: string
  format?: string | undefined
  [key: string]: unknown
}>

export type JobOutputSink = JobOutputWebhookSink

export type JobOutputConfig = Readonly<{
  sinks: readonly JobOutputSink[]
  [key: string]: unknown
}>

export type JobRecord = {
  jobId: string
  slug: string
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef: string
  trigger: JobTrigger
  /** Present only for schedule-kind triggers; undefined for event triggers. */
  schedule?: JobSchedule | undefined
  input: JobInputTemplate
  output?: JobOutputConfig | undefined
  flow?: JobFlow | undefined
  /** Static managed schedule admission owner set; ["all"] is the wildcard. */
  executionNodes?: readonly string[] | undefined
  disabled: boolean
  lastFireAt?: string | undefined
  nextFireAt?: string | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
  archivedAt?: string | undefined
}

export type InboxEventRecord = {
  eventId: string
  eventSeq: number
  source: string
  event: string
  occurredAt?: string | undefined
  payload: Readonly<Record<string, unknown>>
  status: InboxEventStatus
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  attempts: number
  lastError?: string | undefined
  receivedAt: string
  processedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type EventJobMatchRecord = {
  sourceEventId: string
  jobId: string
  eventSeq: number
  outcome: EventJobOutcome
  reason?: EventJobSkipReason | undefined
  jobRunId?: string | undefined
  targetTaskId?: string | undefined
  createdAt: string
}

export type JobStepRunRecord = {
  jobRunId: string
  stepId: string
  phase: JobStepRunPhase
  status: JobStepRunStatus
  attempt: number
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  branchTaken?: BranchTaken | undefined
  degradation?: Readonly<{ code: string; [key: string]: unknown }> | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type JobRunRecord = {
  jobRunId: string
  jobId: string
  /** Immutable node identity that admitted this schedule/manual run. */
  executionNodeId?: string | undefined
  triggeredAt: string
  triggeredBy: JobRunTrigger
  status: JobRunStatus
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  /** Resolved action snapshot — set for event (webhook) runs; the dispatch tail
   * consumes these instead of the live templated job fields. */
  resolvedScopeRef?: string | undefined
  resolvedLaneRef?: string | undefined
  resolvedInput?: Readonly<Record<string, unknown>> | undefined
  output?: JobOutputConfig | undefined
  /** Source provenance, e.g. { kind:'webhook', source:'wrkq', eventId, eventSeq }. */
  source?: Readonly<Record<string, unknown>> | undefined
  retryAttempts?: number | undefined
  nextAttemptAt?: string | undefined
  lastRetryError?: string | undefined
  reason?: ScheduleJobSkipReason | undefined
  actor: Actor
  actorStamp?: string | undefined
  createdAt: string
  updatedAt: string
}

export type CreateJobInput = {
  jobId?: string | undefined
  slug?: string | undefined
  description?: string | undefined
  projectId: string
  agentId: string
  scopeRef: string
  laneRef?: string | undefined
  /** Canonical trigger. When omitted, `schedule` is promoted to a schedule trigger. */
  trigger?: JobTrigger | undefined
  schedule?: JobSchedule | undefined
  input: JobInputTemplate
  output?: JobOutputConfig | undefined
  flow?: JobFlow | undefined
  executionNodes?: readonly string[] | undefined
  disabled?: boolean | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
  createdAt?: string | undefined
}

export type UpdateJobInput = {
  slug?: string | undefined
  description?: string | null | undefined
  trigger?: JobTrigger | undefined
  schedule?: JobSchedule | undefined
  input?: JobInputTemplate | undefined
  output?: JobOutputConfig | null | undefined
  flow?: JobFlow | undefined
  executionNodes?: readonly string[] | null | undefined
  disabled?: boolean | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type InsertJobStepRunInput = {
  stepId: string
  status?: JobStepRunStatus | undefined
  attempt?: number | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  resultBlock?: string | undefined
  result?: Readonly<Record<string, unknown>> | undefined
  branchTaken?: BranchTaken | undefined
  error?: { code: string; message: string } | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
}

export type UpdateJobStepRunInput = {
  status?: JobStepRunStatus | undefined
  inputAttemptId?: string | null | undefined
  runId?: string | null | undefined
  resultBlock?: string | null | undefined
  result?: Readonly<Record<string, unknown>> | null | undefined
  branchTaken?: BranchTaken | null | undefined
  error?: { code: string; message: string } | null | undefined
  startedAt?: string | null | undefined
  completedAt?: string | null | undefined
}

export type ListJobsInput = {
  projectId?: string | undefined
}

export type AppendJobRunInput = Omit<
  JobRunRecord,
  'jobRunId' | 'actor' | 'createdAt' | 'updatedAt' | 'reason'
> & {
  jobRunId?: string | undefined
  actor?: Actor | undefined
}

export type InsertInboxEventInput = {
  eventId: string
  eventSeq: number
  source?: string | undefined
  event: string
  occurredAt?: string | undefined
  payload: Readonly<Record<string, unknown>>
  receivedAt?: string | undefined
}

export type ClaimInboxEventsInput = {
  now: string
  limit?: number | undefined
  leaseOwner: string
  leaseExpiresAt: string
}

export type RecordEventJobSkipInput = {
  sourceEventId: string
  jobId: string
  eventSeq: number
  reason: EventJobSkipReason
  targetTaskId?: string | undefined
  now?: string | undefined
}

export type MintEventJobRunInput = {
  sourceEventId: string
  eventSeq: number
  jobId: string
  resolvedScopeRef: string
  resolvedLaneRef: string
  resolvedInput: Readonly<Record<string, unknown>>
  source: Readonly<Record<string, unknown>>
  targetTaskId?: string | undefined
  triggeredAt?: string | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
  /** Fresh verified HRC identity of the admitting node; stamped as the run's execution node. */
  executionIdentity?: JobExecutionIdentity | undefined
}

export type ListEventJobMatchesInput = {
  sourceEventId?: string | undefined
  jobId?: string | undefined
  limit?: number | undefined
}

export type UpdateJobRunInput = {
  status?: JobRunStatus | undefined
  inputAttemptId?: string | undefined
  runId?: string | undefined
  errorCode?: string | null | undefined
  errorMessage?: string | null | undefined
  leaseOwner?: string | null | undefined
  leaseExpiresAt?: string | null | undefined
  claimedAt?: string | undefined
  dispatchedAt?: string | undefined
  completedAt?: string | undefined
  retryAttempts?: number | null | undefined
  nextAttemptAt?: string | null | undefined
  lastRetryError?: string | null | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
}

export type JobOutputSinkAttemptStatus = 'pending' | 'succeeded' | 'failed'

export type JobOutputSinkAttemptRecord = {
  jobRunId: string
  sinkIndex: number
  sinkFingerprint: string
  status: JobOutputSinkAttemptStatus
  attempts: number
  nextAttemptAt?: string | undefined
  lastAttemptAt?: string | undefined
  deliveredAt?: string | undefined
  deliveryRequestId?: string | undefined
  payloadHash?: string | undefined
  bodyHash?: string | undefined
  lastError?: string | undefined
  responseStatus?: number | undefined
  createdAt: string
  updatedAt: string
}

export type RecordJobOutputSinkAttemptInput = {
  jobRunId: string
  sinkIndex: number
  sinkFingerprint: string
  status: JobOutputSinkAttemptStatus
  attemptedAt: string
  nextAttemptAt?: string | null | undefined
  deliveredAt?: string | null | undefined
  deliveryRequestId?: string | null | undefined
  payloadHash?: string | null | undefined
  bodyHash?: string | null | undefined
  lastError?: string | null | undefined
  responseStatus?: number | null | undefined
}

export type ClaimDueJobRunsInput = {
  now: string
  limit: number
  leaseOwner: string
  leaseExpiresAt: string
}

export type ClaimedDueJob = {
  job: JobRecord
  jobRun: JobRunRecord
}

export type ClaimDueJobsInput = {
  now: string
  limit?: number | undefined
  leaseOwner?: string | undefined
  leaseExpiresAt?: string | undefined
  actor?: Actor | undefined
  actorStamp?: string | undefined
  executionIdentity?: JobExecutionIdentity | undefined
  /**
   * Called for every due schedule this node refuses to claim. Refused jobs keep
   * their next_fire_at, so an unowned job stays due (and silent) forever unless
   * the caller surfaces it.
   */
  onAdmissionRefused?: ((refusal: JobAdmissionRefusal) => void) | undefined
}

export type JobAdmissionRefusal = Readonly<{
  job: JobRecord
  code: JobExecutionAdmissionFailureCode
}>

export type JobExecutionIdentity = Readonly<{
  nodeId: string
  mode: 'single-node' | 'federated'
  verifiedAt: string
}>

export type JobExecutionAdmissionFailureCode =
  | 'job_execution_disabled'
  | 'job_execution_archived'
  | 'job_execution_unassigned_federated'
  | 'job_execution_wrong_node'

export interface OpenSqliteJobsStoreOptions {
  dbPath: string
}

export type RunRecoveryInput = {
  limit?: number | undefined
  now?: string | undefined
  executionNodeId?: string | undefined
}

export interface JobsStore {
  readonly sqlite: SqliteDatabase
  readonly migrations: {
    applied: string[]
  }
  readonly jobs: {
    create: JobsStore['createJob']
    list: JobsStore['listJobs']
    get: JobsStore['getJob']
    update: JobsStore['updateJob']
    archive: JobsStore['archiveJob']
  }
  readonly jobRuns: {
    append: JobsStore['appendJobRun']
    listByJob: JobsStore['listJobRuns']
    get: JobsStore['getJobRun']
    update: JobsStore['updateJobRun']
    claimDueRuns: JobsStore['claimDueJobRuns']
    listDispatchedNonFlow(input?: {
      limit?: number | undefined
      executionNodeId?: string | undefined
    }): ClaimedDueJob[]
  }
  readonly outputSinkAttempts: {
    get: JobsStore['getJobOutputSinkAttempt']
    record: JobsStore['recordJobOutputSinkAttempt']
    listByJobRun: JobsStore['listJobOutputSinkAttempts']
  }
  readonly jobStepRuns: {
    insertMany: JobsStore['insertJobStepRuns']
    updateStep: JobsStore['updateJobStepRun']
    listByJobRun: JobsStore['listJobStepRuns']
    getById: JobsStore['getJobStepRun']
  }
  createJob(input: CreateJobInput): { job: JobRecord }
  listJobs(input?: ListJobsInput | undefined): { jobs: JobRecord[] }
  getJob(jobId: string): { job: JobRecord | undefined }
  updateJob(jobId: string, patch: UpdateJobInput): { job: JobRecord }
  archiveJob(jobId: string): void
  appendJobRun(input: AppendJobRunInput): { jobRun: JobRunRecord }
  listJobRuns(jobId: string): { jobRuns: JobRunRecord[] }
  getJobRun(jobRunId: string): { jobRun: JobRunRecord | undefined }
  updateJobRun(jobRunId: string, patch: UpdateJobRunInput): { jobRun: JobRunRecord }
  claimDueJobRuns(input: ClaimDueJobRunsInput): { jobRuns: JobRunRecord[] }
  listDispatchedNonFlowJobRuns(input?: RunRecoveryInput | undefined): ClaimedDueJob[]
  getJobOutputSinkAttempt(input: {
    jobRunId: string
    sinkIndex: number
    sinkFingerprint: string
  }): { attempt: JobOutputSinkAttemptRecord | undefined }
  recordJobOutputSinkAttempt(input: RecordJobOutputSinkAttemptInput): {
    attempt: JobOutputSinkAttemptRecord
  }
  listJobOutputSinkAttempts(jobRunId: string): {
    attempts: JobOutputSinkAttemptRecord[]
  }
  insertJobStepRuns(
    jobRunId: string,
    phase: JobStepRunPhase,
    steps: readonly InsertJobStepRunInput[]
  ): { jobStepRuns: JobStepRunRecord[] }
  updateJobStepRun(
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number,
    patch: UpdateJobStepRunInput
  ): { jobStepRun: JobStepRunRecord }
  listJobStepRuns(jobRunId: string): { jobStepRuns: JobStepRunRecord[] }
  getJobStepRun(
    jobRunId: string,
    phase: JobStepRunPhase,
    stepId: string,
    attempt: number
  ): { jobStepRun: JobStepRunRecord | undefined }
  createJobRun(
    jobId: string,
    input: Omit<AppendJobRunInput, 'jobId'>,
    executionIdentity?: JobExecutionIdentity | undefined
  ): { job: JobRecord; jobRun: JobRunRecord }
  claimDueJobs(input: ClaimDueJobsInput): ClaimedDueJob[]
  listInflightFlowJobRuns(input?: RunRecoveryInput | undefined): ClaimedDueJob[]
  listJobRunReaperCandidates(input?: RunRecoveryInput | undefined): ClaimedDueJob[]
  stampLegacyNonterminalJobRuns(executionNodeId: string): { stamped: number }
  readonly eventInbox: {
    insert: JobsStore['insertInboxEvent']
    get: JobsStore['getInboxEvent']
    claimPending: JobsStore['claimPendingInboxEvents']
    markProcessed: JobsStore['markInboxEventProcessed']
    markFailed: JobsStore['markInboxEventFailed']
  }
  insertInboxEvent(input: InsertInboxEventInput): {
    event: InboxEventRecord
    inserted: boolean
  }
  getInboxEvent(eventId: string): { event: InboxEventRecord | undefined }
  claimPendingInboxEvents(input: ClaimInboxEventsInput): InboxEventRecord[]
  markInboxEventProcessed(eventId: string, now?: string | undefined): void
  markInboxEventFailed(eventId: string, error: string, now?: string | undefined): void
  listActiveEventJobs(): { jobs: JobRecord[] }
  getEventJobMatch(sourceEventId: string, jobId: string): { match: EventJobMatchRecord | undefined }
  recordEventJobSkip(input: RecordEventJobSkipInput): { recorded: boolean }
  hasRecentMint(jobId: string, targetTaskId: string, sinceIso: string): boolean
  mintEventJobRun(input: MintEventJobRunInput): {
    jobRun: JobRunRecord
    minted: boolean
  }
  listEventJobMatches(input?: ListEventJobMatchesInput | undefined): {
    matches: EventJobMatchRecord[]
  }
  runInTransaction<T>(fn: (store: JobsStore) => T): T
  close(): void
}
