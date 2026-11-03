import { createEventInbox } from './event-inbox.js'
import { createEventMatches } from './event-matches.js'
import { createJobDefinitions } from './job-definitions.js'
import { createOutputAttempts } from './output-attempts.js'
import { createRunRecords } from './run-records.js'
import { createRunRecovery } from './run-recovery.js'
import { createScheduleClaims } from './schedule-claims.js'
import { createStepRuns } from './step-runs.js'
import type { JobsStore, OpenSqliteJobsStoreOptions } from './store-contracts.js'
import {
  createSqliteDatabase,
  listAppliedJobsStoreMigrations,
  runJobsStoreMigrations,
} from './store-schema.js'

export function openSqliteJobsStore(options: OpenSqliteJobsStoreOptions): JobsStore {
  const sqlite = createSqliteDatabase(options.dbPath)
  runJobsStoreMigrations(sqlite)
  const jobDefinitions = createJobDefinitions(sqlite)
  const runRecords = createRunRecords(sqlite)
  const stepRuns = createStepRuns(sqlite)
  const runRecovery = createRunRecovery(sqlite)
  const scheduleClaims = createScheduleClaims(sqlite, runRecords.appendJobRun)
  const eventInbox = createEventInbox(sqlite)
  const eventMatches = createEventMatches(sqlite, runRecords.appendJobRun, runRecords.getJobRun)
  const outputAttempts = createOutputAttempts(sqlite)
  const store: JobsStore = {
    sqlite,
    // A readiness hint, never authorization. A subsequent verified tick still
    // transactionally claims and validates work; arrivals after this query wait
    // at most one normal scheduler interval.
    hasSchedulerWork(now: string): boolean {
      const row = sqlite
        .prepare(`
        SELECT EXISTS(SELECT 1 FROM jobs WHERE archived_at IS NULL AND disabled = 0
          AND trigger_kind = 'schedule' AND (next_fire_at IS NULL OR next_fire_at <= ?))
        OR EXISTS(SELECT 1 FROM event_inbox WHERE status = 'pending'
          OR (status = 'leased' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
        AS ready
      `)
        .get(now, now) as { ready: number }
      return (
        row.ready !== 0 ||
        runRecovery.listJobRunReaperCandidates({ now, limit: 1 }).length > 0 ||
        runRecovery.listDispatchedNonFlowJobRuns({ now, limit: 1 }).length > 0
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
