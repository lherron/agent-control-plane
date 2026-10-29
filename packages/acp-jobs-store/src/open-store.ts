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
