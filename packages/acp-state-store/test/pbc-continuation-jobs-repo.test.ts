/**
 * RED TESTS — Phase 4a: PbcContinuationJobsRepo (T-02754)
 *
 * Table: pbc_continuation_jobs
 *   job_id TEXT PRIMARY KEY
 *   task_id TEXT NOT NULL
 *   workflow_ref TEXT NOT NULL
 *   revision_at_admission TEXT NOT NULL  -- wrkq task revision / etag at time of admit
 *   idempotency_key TEXT NOT NULL
 *   status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
 *   attempt INTEGER NOT NULL DEFAULT 0
 *   lease_owner TEXT
 *   lease_expires_at TEXT
 *   stop_reason TEXT
 *   result_json TEXT
 *   error_json TEXT
 *   created_at TEXT NOT NULL
 *   started_at TEXT
 *   finished_at TEXT
 *   updated_at TEXT NOT NULL
 *   UNIQUE (task_id, revision_at_admission, idempotency_key)
 *
 * All tests in this file FAIL NOW — the repo, migration, and store property
 * do not exist yet.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT
 *
 * 1. packages/acp-state-store/src/repos/pbc-continuation-jobs-repo.ts
 *    Export PbcContinuationJobsRepo class with:
 *
 *    admit(input: {
 *      taskId: string
 *      workflowRef: string
 *      revisionAtAdmission: string
 *      idempotencyKey: string
 *    }): { job: PbcContinuationJob; created: boolean }
 *      — INSERT with job_id = shortId('job_'), status='queued', attempt=0, created: true
 *      — If (task_id, revision_at_admission, idempotency_key) already exists → return existing job, created: false
 *
 *    get(jobId: string): PbcContinuationJob | undefined
 *
 *    acquireLease(input: {
 *      jobId: string
 *      leaseOwner: string
 *      leaseExpiresAt: string
 *    }): { job: PbcContinuationJob; acquired: boolean }
 *      — Acquires lease only if status='queued' or (status='running' and lease expired).
 *        Sets status='running', lease_owner, lease_expires_at, attempt++.
 *        Returns { acquired: true } on success, { acquired: false } if already leased/terminal.
 *
 *    renewLease(input: {
 *      jobId: string
 *      leaseOwner: string
 *      leaseExpiresAt: string
 *    }): PbcContinuationJob
 *      — Extends lease_expires_at. Only succeeds if lease_owner matches.
 *        Throws if lease_owner mismatch or job in terminal state.
 *
 *    releaseLease(input: {
 *      jobId: string
 *      leaseOwner: string
 *    }): PbcContinuationJob
 *      — Clears lease_owner + lease_expires_at, sets status='queued'.
 *        Only succeeds if lease_owner matches.
 *
 *    transition(input: {
 *      jobId: string
 *      toStatus: 'succeeded' | 'failed' | 'cancelled'
 *      resultJson?: unknown
 *      errorJson?: unknown
 *      stopReason?: string
 *    }): PbcContinuationJob
 *      — Sets status, finished_at. Allowed: running→succeeded, running→failed, any→cancelled.
 *        Throws if already in a terminal state.
 *
 *    listByStatus(status: PbcContinuationJobStatus): readonly PbcContinuationJob[]
 *
 * 2. Export PbcContinuationJob type and PbcContinuationJobStatus type:
 *    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
 *
 * 3. packages/acp-state-store/src/open-store.ts
 *    Add migration for pbc_continuation_jobs (additive, CREATE TABLE IF NOT EXISTS).
 *    Add pbcContinuationJobs: PbcContinuationJobsRepo to AcpStateStore interface + factory.
 *
 * 4. packages/acp-state-store/src/index.ts
 *    Export PbcContinuationJobsRepo, PbcContinuationJob, PbcContinuationJobStatus.
 *
 * Crash/replay: revisionAtAdmission + idempotencyKey dedupe ensures a retry after crash
 * returns the prior job instead of creating a duplicate. Reading result_json on a
 * 'succeeded' job is the "operation already achieved" signal — no double-apply.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'

// Local type mirrors for test assertions (not imported — file doesn't exist yet)
type PbcContinuationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

type PbcContinuationJob = {
  jobId: string
  taskId: string
  workflowRef: string
  revisionAtAdmission: string
  idempotencyKey: string
  status: PbcContinuationJobStatus
  attempt: number
  leaseOwner?: string
  leaseExpiresAt?: string
  stopReason?: string
  resultJson?: unknown
  errorJson?: unknown
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
}

type AdmitResult = { job: PbcContinuationJob; created: boolean }
type AcquireLeaseResult = { job: PbcContinuationJob; acquired: boolean }

type PbcContinuationJobsRepo = {
  admit(input: {
    taskId: string
    workflowRef: string
    revisionAtAdmission: string
    idempotencyKey: string
  }): AdmitResult
  get(jobId: string): PbcContinuationJob | undefined
  acquireLease(input: {
    jobId: string
    leaseOwner: string
    leaseExpiresAt: string
  }): AcquireLeaseResult
  renewLease(input: { jobId: string; leaseOwner: string; leaseExpiresAt: string }): PbcContinuationJob
  releaseLease(input: { jobId: string; leaseOwner: string }): PbcContinuationJob
  transition(input: {
    jobId: string
    toStatus: 'succeeded' | 'failed' | 'cancelled'
    resultJson?: unknown
    errorJson?: unknown
    stopReason?: string
  }): PbcContinuationJob
  listByStatus(status: PbcContinuationJobStatus): readonly PbcContinuationJob[]
}

function getRepo(store: ReturnType<typeof openAcpStateStore>): PbcContinuationJobsRepo {
  // FAILS until open-store.ts exposes pbcContinuationJobs
  const repo = (store as unknown as Record<string, unknown>)['pbcContinuationJobs']
  if (repo === undefined) {
    throw new Error(
      'store.pbcContinuationJobs is undefined — PbcContinuationJobsRepo not yet added to AcpStateStore'
    )
  }
  return repo as PbcContinuationJobsRepo
}

const BASE_ADMIT = {
  taskId: 'T-09990',
  workflowRef: 'canonical-flow@v1',
  revisionAtAdmission: 'etag-rev-42',
  idempotencyKey: 'pbc-job-idem-001',
}

const LEASE_OWNER = 'worker-node-01'
const LEASE_EXPIRES = '2099-01-01T00:05:00.000Z'

// ─── Section 1: admit — initial creation ─────────────────────────────────────

describe('PbcContinuationJobsRepo.admit — initial creation (Phase 4a red)', () => {
  test('[RED] admit returns { job, created: true } on first call', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const result = repo.admit(BASE_ADMIT)
      expect(result.created).toBe(true)
      expect(result.job).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('[RED] admitted job has status=queued, attempt=0', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      expect(job.status).toBe('queued')
      expect(job.attempt).toBe(0)
    } finally {
      store.close()
    }
  })

  test('[RED] admitted job carries the input fields', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      expect(job.taskId).toBe(BASE_ADMIT.taskId)
      expect(job.workflowRef).toBe(BASE_ADMIT.workflowRef)
      expect(job.revisionAtAdmission).toBe(BASE_ADMIT.revisionAtAdmission)
      expect(job.idempotencyKey).toBe(BASE_ADMIT.idempotencyKey)
    } finally {
      store.close()
    }
  })

  test('[RED] admitted job has a non-empty jobId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      expect(typeof job.jobId).toBe('string')
      expect(job.jobId.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  test('[RED] admitted job is retrievable via get(jobId)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      const found = repo.get(job.jobId)
      expect(found).toBeDefined()
      expect(found?.jobId).toBe(job.jobId)
    } finally {
      store.close()
    }
  })

  test('[RED] get returns undefined for a non-existent jobId', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      expect(repo.get('job_nonexistent')).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

// ─── Section 2: admit — dedupe / replay ──────────────────────────────────────

describe('PbcContinuationJobsRepo.admit — dedupe replay (Phase 4a red)', () => {
  test('[RED] second admit with same (taskId, revisionAtAdmission, idempotencyKey) returns created:false', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admit(BASE_ADMIT)
      const r2 = repo.admit(BASE_ADMIT)
      expect(r2.created).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] replay returns the same jobId as the original', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      const r2 = repo.admit(BASE_ADMIT)
      expect(r2.job.jobId).toBe(r1.job.jobId)
    } finally {
      store.close()
    }
  })

  test('[RED] replay preserves the original createdAt (no new row inserted)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      const r2 = repo.admit(BASE_ADMIT)
      expect(r2.job.createdAt).toBe(r1.job.createdAt)
    } finally {
      store.close()
    }
  })

  test('[RED] only one row exists after multiple admit calls for same composite key', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      repo.admit(BASE_ADMIT)
      repo.admit(BASE_ADMIT)
      repo.admit(BASE_ADMIT)
      const all = repo.listByStatus('queued')
      const matches = all.filter(
        (j) => j.taskId === BASE_ADMIT.taskId && j.idempotencyKey === BASE_ADMIT.idempotencyKey
      )
      expect(matches).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  test('[RED] different idempotencyKey for same taskId+revision creates a distinct job', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      const r2 = repo.admit({ ...BASE_ADMIT, idempotencyKey: 'pbc-job-idem-002' })
      expect(r2.created).toBe(true)
      expect(r2.job.jobId).not.toBe(r1.job.jobId)
    } finally {
      store.close()
    }
  })

  test('[RED] different revisionAtAdmission for same taskId+key creates a distinct job', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      const r2 = repo.admit({ ...BASE_ADMIT, revisionAtAdmission: 'etag-rev-99' })
      expect(r2.created).toBe(true)
      expect(r2.job.jobId).not.toBe(r1.job.jobId)
    } finally {
      store.close()
    }
  })
})

// ─── Section 3: acquireLease ──────────────────────────────────────────────────

describe('PbcContinuationJobsRepo.acquireLease (Phase 4a red)', () => {
  test('[RED] acquireLease on a queued job succeeds: returns { acquired: true }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      const result = repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      expect(result.acquired).toBe(true)
    } finally {
      store.close()
    }
  })

  test('[RED] after acquireLease: status=running, leaseOwner set, attempt incremented', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      const { job: leased } = repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      expect(leased.status).toBe('running')
      expect(leased.leaseOwner).toBe(LEASE_OWNER)
      expect(leased.leaseExpiresAt).toBe(LEASE_EXPIRES)
      expect(leased.attempt).toBe(1)
    } finally {
      store.close()
    }
  })

  test('[RED] second acquireLease on already-running (non-expired) job returns { acquired: false }', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const r2 = repo.acquireLease({ jobId: job.jobId, leaseOwner: 'worker-node-02', leaseExpiresAt: LEASE_EXPIRES })
      expect(r2.acquired).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] acquireLease returns { acquired: false } for a terminal job (succeeded)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: job.jobId, toStatus: 'succeeded', resultJson: { ok: true } })
      const r2 = repo.acquireLease({ jobId: job.jobId, leaseOwner: 'worker-node-02', leaseExpiresAt: LEASE_EXPIRES })
      expect(r2.acquired).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] listByStatus(running) returns the leased job', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const running = repo.listByStatus('running')
      expect(running.some((j) => j.jobId === job.jobId)).toBe(true)
    } finally {
      store.close()
    }
  })
})

// ─── Section 4: renewLease ────────────────────────────────────────────────────

describe('PbcContinuationJobsRepo.renewLease (Phase 4a red)', () => {
  test('[RED] renewLease extends leaseExpiresAt for the matching owner', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const newExpiry = '2099-01-01T00:15:00.000Z'
      const renewed = repo.renewLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: newExpiry })
      expect(renewed.leaseExpiresAt).toBe(newExpiry)
      expect(renewed.leaseOwner).toBe(LEASE_OWNER)
      expect(renewed.status).toBe('running')
    } finally {
      store.close()
    }
  })

  test('[RED] renewLease throws when leaseOwner does not match', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      expect(() =>
        repo.renewLease({ jobId: job.jobId, leaseOwner: 'wrong-owner', leaseExpiresAt: LEASE_EXPIRES })
      ).toThrow()
    } finally {
      store.close()
    }
  })
})

// ─── Section 5: releaseLease ──────────────────────────────────────────────────

describe('PbcContinuationJobsRepo.releaseLease (Phase 4a red)', () => {
  test('[RED] releaseLease resets job to queued with cleared lease fields', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const released = repo.releaseLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER })
      expect(released.status).toBe('queued')
      expect(released.leaseOwner).toBeUndefined()
      expect(released.leaseExpiresAt).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('[RED] releaseLease throws when leaseOwner does not match', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      expect(() =>
        repo.releaseLease({ jobId: job.jobId, leaseOwner: 'wrong-owner' })
      ).toThrow()
    } finally {
      store.close()
    }
  })

  test('[RED] after releaseLease, a second acquireLease can succeed', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.releaseLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER })

      const r2 = repo.acquireLease({ jobId: job.jobId, leaseOwner: 'worker-node-02', leaseExpiresAt: LEASE_EXPIRES })
      expect(r2.acquired).toBe(true)
      expect(r2.job.attempt).toBe(2)
    } finally {
      store.close()
    }
  })
})

// ─── Section 6: transition — terminal status ─────────────────────────────────

describe('PbcContinuationJobsRepo.transition — terminal status (Phase 4a red)', () => {
  test('[RED] transition to succeeded sets status=succeeded, finished_at, result_json', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const done = repo.transition({ jobId: job.jobId, toStatus: 'succeeded', resultJson: { outputs: ['out_001'] } })
      expect(done.status).toBe('succeeded')
      expect(done.resultJson).toEqual({ outputs: ['out_001'] })
      expect(done.finishedAt).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('[RED] transition to failed sets status=failed, finished_at, error_json', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const failed = repo.transition({ jobId: job.jobId, toStatus: 'failed', errorJson: { code: 'TIMEOUT' } })
      expect(failed.status).toBe('failed')
      expect(failed.errorJson).toEqual({ code: 'TIMEOUT' })
      expect(failed.finishedAt).toBeDefined()
    } finally {
      store.close()
    }
  })

  test('[RED] transition to cancelled sets status=cancelled and stopReason', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      const cancelled = repo.transition({ jobId: job.jobId, toStatus: 'cancelled', stopReason: 'task-aborted' })
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.stopReason).toBe('task-aborted')
    } finally {
      store.close()
    }
  })

  test('[RED] get after transition returns the terminal job', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: job.jobId, toStatus: 'succeeded', resultJson: { ok: true } })
      const found = repo.get(job.jobId)
      expect(found?.status).toBe('succeeded')
      expect(found?.resultJson).toEqual({ ok: true })
    } finally {
      store.close()
    }
  })

  test('[RED] transition throws when already in terminal state succeeded', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: job.jobId, toStatus: 'succeeded', resultJson: { ok: true } })
      expect(() =>
        repo.transition({ jobId: job.jobId, toStatus: 'failed', errorJson: { code: 'RE-ENTER' } })
      ).toThrow()
    } finally {
      store.close()
    }
  })

  test('[RED] transition throws when already in terminal state failed', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: job.jobId, toStatus: 'failed', errorJson: { code: 'ERR' } })
      expect(() =>
        repo.transition({ jobId: job.jobId, toStatus: 'succeeded', resultJson: {} })
      ).toThrow()
    } finally {
      store.close()
    }
  })

  test('[RED] transition throws when already cancelled', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const { job } = repo.admit(BASE_ADMIT)
      repo.transition({ jobId: job.jobId, toStatus: 'cancelled', stopReason: 'first-cancel' })
      expect(() =>
        repo.transition({ jobId: job.jobId, toStatus: 'cancelled', stopReason: 'second-cancel' })
      ).toThrow()
    } finally {
      store.close()
    }
  })
})

// ─── Section 7: replay returns prior result (operation already-achieved) ──────

describe('PbcContinuationJobsRepo — replay returns prior result (Phase 4a red)', () => {
  test('[RED] admit after succeeded job returns the existing succeeded job (not created)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: r1.job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: r1.job.jobId, toStatus: 'succeeded', resultJson: { finalOutput: 'X' } })

      // Crash-recovery: admit again with same composite key → should replay, not create duplicate
      const r2 = repo.admit(BASE_ADMIT)
      expect(r2.created).toBe(false)
      expect(r2.job.jobId).toBe(r1.job.jobId)
      expect(r2.job.status).toBe('succeeded')
      expect(r2.job.resultJson).toEqual({ finalOutput: 'X' })
    } finally {
      store.close()
    }
  })

  test('[RED] admit after failed job returns the existing failed job (crash-safe, no double-apply)', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const r1 = repo.admit(BASE_ADMIT)
      repo.acquireLease({ jobId: r1.job.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: r1.job.jobId, toStatus: 'failed', errorJson: { code: 'TIMED_OUT' } })

      const r2 = repo.admit(BASE_ADMIT)
      expect(r2.created).toBe(false)
      expect(r2.job.status).toBe('failed')
      expect(r2.job.errorJson).toEqual({ code: 'TIMED_OUT' })
    } finally {
      store.close()
    }
  })
})

// ─── Section 8: listByStatus ──────────────────────────────────────────────────

describe('PbcContinuationJobsRepo.listByStatus (Phase 4a red)', () => {
  test('[RED] listByStatus(queued) returns only queued jobs', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const j1 = repo.admit(BASE_ADMIT).job
      const j2 = repo.admit({ ...BASE_ADMIT, idempotencyKey: 'key-two' }).job
      repo.acquireLease({ jobId: j2.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })

      const queued = repo.listByStatus('queued')
      expect(queued.some((j) => j.jobId === j1.jobId)).toBe(true)
      expect(queued.some((j) => j.jobId === j2.jobId)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] listByStatus(running) returns only running jobs', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const j1 = repo.admit(BASE_ADMIT).job
      repo.acquireLease({ jobId: j1.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      const j2 = repo.admit({ ...BASE_ADMIT, idempotencyKey: 'key-two' }).job
      // j2 stays queued

      const running = repo.listByStatus('running')
      expect(running.some((j) => j.jobId === j1.jobId)).toBe(true)
      expect(running.some((j) => j.jobId === j2.jobId)).toBe(false)
    } finally {
      store.close()
    }
  })

  test('[RED] listByStatus(succeeded) returns only succeeded jobs', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const repo = getRepo(store)
      const j1 = repo.admit(BASE_ADMIT).job
      repo.acquireLease({ jobId: j1.jobId, leaseOwner: LEASE_OWNER, leaseExpiresAt: LEASE_EXPIRES })
      repo.transition({ jobId: j1.jobId, toStatus: 'succeeded', resultJson: {} })

      const j2 = repo.admit({ ...BASE_ADMIT, idempotencyKey: 'key-two' }).job
      // j2 stays queued

      const succeeded = repo.listByStatus('succeeded')
      expect(succeeded.some((j) => j.jobId === j1.jobId)).toBe(true)
      expect(succeeded.some((j) => j.jobId === j2.jobId)).toBe(false)
    } finally {
      store.close()
    }
  })
})
