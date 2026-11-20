import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { observeSqliteCommits } from 'acp-core'

import { initializeSchema } from './initialize-schema.js'
import { migrateLegacySchema } from './migrate-legacy-schema.js'
import { InputAdmissionRepo } from './repos/input-admission-repo.js'
import { InputApplicationRepo } from './repos/input-application-repo.js'
import { InputAttemptRepo } from './repos/input-attempt-repo.js'
import { InputQueueRepo } from './repos/input-queue-repo.js'
import { MobileTimelineProjectionRepo } from './repos/mobile-timeline-projection-repo.js'
import { PbcContinuationJobsRepo } from './repos/pbc-continuation-jobs-repo.js'
import { RunRepo } from './repos/run-repo.js'
import { SessionAdmissionSequenceRepo } from './repos/session-admission-sequence-repo.js'
import type { RepoContext } from './repos/shared.js'
import { TransitionOutboxRepo } from './repos/transition-outbox-repo.js'
import { WorkflowRuntimeRepo } from './repos/workflow-runtime-repo.js'
import { WrkfParticipantCapturesRepo } from './repos/wrkf-participant-captures-repo.js'
import { WrkfRouteIdempotencyRepo } from './repos/wrkf-route-idempotency-repo.js'
import Database, { type SqliteDatabase } from './sqlite.js'

export interface OpenAcpStateStoreOptions {
  onCommit?: ((tables: ReadonlySet<string>) => void) | undefined
  dbPath: string
}

export interface AcpStateStore {
  readonly sqlite: SqliteDatabase
  readonly runs: RunRepo
  readonly inputAttempts: InputAttemptRepo
  readonly inputAdmissions: InputAdmissionRepo
  readonly inputApplications: InputApplicationRepo
  readonly inputQueue: InputQueueRepo
  readonly sessionAdmissionSequences: SessionAdmissionSequenceRepo
  readonly transitionOutbox: TransitionOutboxRepo
  readonly workflowRuntime: WorkflowRuntimeRepo
  readonly wrkfRouteIdempotency: WrkfRouteIdempotencyRepo
  readonly wrkfParticipantCaptures: WrkfParticipantCapturesRepo
  readonly pbcContinuationJobs: PbcContinuationJobsRepo
  readonly mobileTimeline: MobileTimelineProjectionRepo
  runInTransaction<T>(fn: (store: AcpStateStore) => T): T
  close(): void
}

function isEphemeralPath(path: string): boolean {
  return path === '' || path === ':memory:'
}

function createSqliteDatabase(dbPath: string): SqliteDatabase {
  if (!isEphemeralPath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const sqlite = new Database(dbPath)
  // busy_timeout first: journal_mode takes a lock, and without a timeout a
  // concurrent writer or closing checkpoint fails the open with SQLITE_BUSY.
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  return sqlite
}

export function openAcpStateStore(options: OpenAcpStateStoreOptions): AcpStateStore {
  const rawSqlite = createSqliteDatabase(options.dbPath)
  initializeSchema(rawSqlite)
  migrateLegacySchema(rawSqlite)

  const sqlite = observeSqliteCommits(rawSqlite, options.onCommit)
  const context: RepoContext = {
    sqlite,
  }

  const store = {
    sqlite,
    runs: new RunRepo(context),
    inputAttempts: new InputAttemptRepo(context),
    inputAdmissions: new InputAdmissionRepo(context),
    inputApplications: new InputApplicationRepo(context),
    inputQueue: new InputQueueRepo(context),
    sessionAdmissionSequences: new SessionAdmissionSequenceRepo(context),
    transitionOutbox: new TransitionOutboxRepo(context),
    workflowRuntime: new WorkflowRuntimeRepo(context),
    wrkfRouteIdempotency: new WrkfRouteIdempotencyRepo(context),
    wrkfParticipantCaptures: new WrkfParticipantCapturesRepo(context),
    pbcContinuationJobs: new PbcContinuationJobsRepo(context),
    mobileTimeline: new MobileTimelineProjectionRepo(context),
    runInTransaction<T>(fn: (activeStore: AcpStateStore) => T): T {
      return sqlite.transaction(() => fn(store))()
    },
    close(): void {
      sqlite.close()
    },
  } satisfies AcpStateStore

  return store
}
