import { observeSqliteCommits } from 'acp-core'
import { createEventInbox } from './event-inbox.js'
import { createEventMatches } from './event-matches.js'
import { JobExecutionAdmissionError, assertJobExecutionAdmission } from './execution-admission.js'
import { createJobDefinitions } from './job-definitions.js'
import { createOutputAttempts } from './output-attempts.js'
import { type JobRow, toJobRecord } from './row-codecs.js'
import { createRunRecords } from './run-records.js'
import { createRunRecovery } from './run-recovery.js'
import { createScheduleClaims } from './schedule-claims.js'
import { createStepRuns } from './step-runs.js'
import type {
  JobAdmissionRefusal,
  JobExecutionIdentity,
  JobsStore,
  OpenSqliteJobsStoreOptions,
} from './store-contracts.js'
import {
  createSqliteDatabase,
  listAppliedJobsStoreMigrations,
  runJobsStoreMigrations,
} from './store-schema.js'

export function openSqliteJobsStore(options: OpenSqliteJobsStoreOptions): JobsStore {
  const rawSqlite = createSqliteDatabase(options.dbPath)
  runJobsStoreMigrations(rawSqlite)
  const sqlite = observeSqliteCommits(rawSqlite, options.onCommit)
  const jobDefinitions = createJobDefinitions(sqlite)
  const runRecords = createRunRecords(sqlite)
  const stepRuns = createStepRuns(sqlite)
  const runRecovery = createRunRecovery(sqlite)
  const scheduleClaims = createScheduleClaims(sqlite, runRecords.appendJobRun)
  const eventInbox = createEventInbox(sqlite)
  const eventMatches = createEventMatches(sqlite, runRecords.appendJobRun, runRecords.getJobRun)
  const outputAttempts = createOutputAttempts(sqlite)
  let exclusions = new Map<string, string>()
  const store: JobsStore = {
    sqlite,
    // A readiness hint, never authorization. A subsequent verified tick still
    // transactionally claims and validates work; arrivals after this query wait
    // at most one normal scheduler interval.
    hasSchedulerWork(
      now: string,
      baseline?: JobExecutionIdentity | undefined,
      onAdmissionRefused?: ((refusal: JobAdmissionRefusal) => void) | undefined
    ): boolean {
      // Re-evaluate row changes on every hint. This is not an admission cache:
      // assigning an excluded schedule makes it eligible on the next tick.
      const schedules = sqlite
        .prepare(`
        SELECT * FROM jobs WHERE archived_at IS NULL AND disabled = 0
          AND trigger_kind = 'schedule'
      `)
        .all() as JobRow[]
      let eligible = false
      const nextExclusions = new Map<string, string>()
      for (const row of schedules) {
        if (baseline !== undefined) {
          const job = toJobRecord(row)
          try {
            // Negative filter only; a work-running tick still verifies fresh.
            assertJobExecutionAdmission(job, baseline)
          } catch (error) {
            if (!(error instanceof JobExecutionAdmissionError)) throw error
            nextExclusions.set(job.jobId, error.code)
            if (onAdmissionRefused !== undefined && exclusions.get(job.jobId) !== error.code) {
              onAdmissionRefused({ job, code: error.code })
            }
            continue
          }
        }
        if (row.next_fire_at === null || row.next_fire_at <= now) eligible = true
      }
      // Forget exclusions which cleared, so a later exclusion is visible again.
      if (onAdmissionRefused !== undefined) exclusions = nextExclusions
      const inbox = sqlite
        .prepare(`
        SELECT EXISTS(SELECT 1 FROM event_inbox WHERE status = 'pending'
          OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))) AS ready
      `)
        .get(now) as { ready: number }
      const recovery = {
        now,
        limit: 1,
        ...(baseline !== undefined ? { executionNodeId: baseline.nodeId } : {}),
      }
      return (
        eligible ||
        inbox.ready !== 0 ||
        runRecovery.listJobRunReaperCandidates(recovery).length > 0 ||
        runRecovery.listDispatchedNonFlowJobRuns(recovery).length > 0
      )
    },
    migrations: {
      applied: listAppliedJobsStoreMigrations(sqlite),
    },
    jobs: {
      create: jobDefinitions.createJob,
      list: jobDefinitions.listJobs,
      get: jobDefinitions.getJob,
      update: jobDefinitions.updateJob,
      archive: jobDefinitions.archiveJob,
    },
    jobRuns: {
      append: runRecords.appendJobRun,
      listByJob: runRecords.listJobRuns,
      get: runRecords.getJobRun,
      update: runRecords.updateJobRun,
      claimDueRuns: runRecords.claimDueJobRuns,
      listDispatchedNonFlow: runRecovery.listDispatchedNonFlowJobRuns,
    },
    outputSinkAttempts: {
      get: outputAttempts.getJobOutputSinkAttempt,
      record: outputAttempts.recordJobOutputSinkAttempt,
      listByJobRun: outputAttempts.listJobOutputSinkAttempts,
    },
    jobStepRuns: {
      insertMany: stepRuns.insertJobStepRuns,
      updateStep: stepRuns.updateJobStepRun,
      listByJobRun: stepRuns.listJobStepRuns,
      getById: stepRuns.getJobStepRun,
    },
    eventInbox: {
      insert: eventInbox.insertInboxEvent,
      get: eventInbox.getInboxEvent,
      claimPending: eventInbox.claimPendingInboxEvents,
      markProcessed: eventInbox.markInboxEventProcessed,
      markFailed: eventInbox.markInboxEventFailed,
    },
    ...jobDefinitions,
    ...runRecords,
    ...stepRuns,
    ...runRecovery,
    ...scheduleClaims,
    ...eventInbox,
    ...eventMatches,
    ...outputAttempts,
    runInTransaction<T>(fn: (innerStore: JobsStore) => T): T {
      const transaction = sqlite.transaction(() => fn(store))
      return transaction()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies JobsStore
  return store
}

export function createInMemoryJobsStore(): JobsStore {
  return openSqliteJobsStore({ dbPath: ':memory:' })
}
