/**
 * Characterization tests for the two optimistic claim-and-lease loops in
 * open-store.ts: `claimDueJobRuns` (job_runs) and `claimPendingInboxEvents`
 * (event_inbox).
 *
 * These pin the CURRENT observable behavior — which rows get claimed, the
 * lease/ordering semantics, the returned shape/values, the SQL side effects,
 * and the not-claimed cases — so the F4 shared-loop extraction (wrkq T-04532)
 * can be proven behavior-preserving. The two loops have DISTINCT WHERE
 * predicates (job_runs adds `triggered_at <= ?`; event_inbox does
 * `attempts + 1`), and both branches must remain pinned independently.
 */
import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

type JobRunRow = {
  status: string
  lease_owner: string | null
  lease_expires_at: string | null
  claimed_at: string | null
  updated_at: string
  triggered_at: string
}

type InboxRow = {
  status: string
  lease_owner: string | null
  lease_expires_at: string | null
  attempts: number
  updated_at: string
}

function readJobRunRow(
  store: ReturnType<typeof createInMemoryJobsStore>,
  jobRunId: string
): JobRunRow {
  return store.sqlite
    .prepare(
      'SELECT status, lease_owner, lease_expires_at, claimed_at, updated_at, triggered_at FROM job_runs WHERE job_run_id = ?'
    )
    .get(jobRunId) as JobRunRow
}

function readInboxRow(
  store: ReturnType<typeof createInMemoryJobsStore>,
  eventId: string
): InboxRow {
  return store.sqlite
    .prepare(
      'SELECT status, lease_owner, lease_expires_at, attempts, updated_at FROM event_inbox WHERE event_id = ?'
    )
    .get(eventId) as InboxRow
}

function seedJobRun(
  store: ReturnType<typeof createInMemoryJobsStore>,
  overrides: {
    jobRunId: string
    triggeredAt: string
    status?: 'pending' | 'claimed'
    leaseOwner?: string | undefined
    leaseExpiresAt?: string | undefined
    claimedAt?: string | undefined
  }
): void {
  store.appendJobRun({
    jobId: 'job_chr',
    jobRunId: overrides.jobRunId,
    triggeredAt: overrides.triggeredAt,
    triggeredBy: 'manual',
    status: overrides.status ?? 'pending',
    ...(overrides.leaseOwner !== undefined ? { leaseOwner: overrides.leaseOwner } : {}),
    ...(overrides.leaseExpiresAt !== undefined ? { leaseExpiresAt: overrides.leaseExpiresAt } : {}),
    ...(overrides.claimedAt !== undefined ? { claimedAt: overrides.claimedAt } : {}),
  })
}

function seedInboxEvent(
  store: ReturnType<typeof createInMemoryJobsStore>,
  eventId: string,
  eventSeq: number
): string {
  return store.insertInboxEvent({
    eventId,
    eventSeq,
    source: 'wrkq',
    event: 'created',
    payload: { event_id: eventId, event_seq: eventSeq },
  }).event.eventId
}

describe('characterization: claimDueJobRuns (job_runs claim-and-lease loop)', () => {
  test('claims a due pending run and sets the full lease/claim column set', () => {
    const store = createInMemoryJobsStore()
    try {
      seedJobRun(store, { jobRunId: 'jr_a', triggeredAt: '2026-04-23T12:00:00.000Z' })

      const { jobRuns } = store.claimDueJobRuns({
        now: '2026-04-23T12:00:00.000Z',
        limit: 10,
        leaseOwner: 'owner:1',
        leaseExpiresAt: '2026-04-23T12:05:00.000Z',
      })

      // Returned shape: { jobRuns: JobRunRecord[] } with full records.
      expect(jobRuns).toHaveLength(1)
      expect(jobRuns[0]).toEqual(
        expect.objectContaining({
          jobRunId: 'jr_a',
          jobId: 'job_chr',
          status: 'claimed',
          leaseOwner: 'owner:1',
          leaseExpiresAt: '2026-04-23T12:05:00.000Z',
          claimedAt: '2026-04-23T12:00:00.000Z',
        })
      )

      // SQL side effects: status/lease_owner/lease_expires_at/claimed_at/updated_at all set to now-derived values.
      const row = readJobRunRow(store, 'jr_a')
      expect(row.status).toBe('claimed')
      expect(row.lease_owner).toBe('owner:1')
      expect(row.lease_expires_at).toBe('2026-04-23T12:05:00.000Z')
      expect(row.claimed_at).toBe('2026-04-23T12:00:00.000Z')
      expect(row.updated_at).toBe('2026-04-23T12:00:00.000Z')
    } finally {
      store.close()
    }
  })

  test('does NOT claim a run whose triggered_at is in the future (triggered_at <= now predicate)', () => {
    const store = createInMemoryJobsStore()
    try {
      seedJobRun(store, { jobRunId: 'jr_future', triggeredAt: '2026-04-23T13:00:00.000Z' })

      const { jobRuns } = store.claimDueJobRuns({
        now: '2026-04-23T12:00:00.000Z',
        limit: 10,
        leaseOwner: 'owner:1',
        leaseExpiresAt: '2026-04-23T12:05:00.000Z',
      })

      expect(jobRuns).toHaveLength(0)
      // Row untouched.
      const row = readJobRunRow(store, 'jr_future')
      expect(row.status).toBe('pending')
      expect(row.lease_owner).toBeNull()
    } finally {
      store.close()
    }
  })

  test('orders candidates by triggered_at ASC, job_run_id ASC and respects the limit', () => {
    const store = createInMemoryJobsStore()
    try {
      // Same triggered_at for b/c to exercise the job_run_id ASC tie-break; a is earliest.
      seedJobRun(store, { jobRunId: 'jr_c', triggeredAt: '2026-04-23T11:30:00.000Z' })
      seedJobRun(store, { jobRunId: 'jr_b', triggeredAt: '2026-04-23T11:30:00.000Z' })
      seedJobRun(store, { jobRunId: 'jr_a', triggeredAt: '2026-04-23T11:00:00.000Z' })

      const { jobRuns } = store.claimDueJobRuns({
        now: '2026-04-23T12:00:00.000Z',
        limit: 2,
        leaseOwner: 'owner:1',
        leaseExpiresAt: '2026-04-23T12:05:00.000Z',
      })

      // limit=2 → only the two earliest in (triggered_at ASC, job_run_id ASC) order.
      expect(jobRuns.map((r) => r.jobRunId)).toEqual(['jr_a', 'jr_b'])
      // jr_c remains unclaimed.
      expect(readJobRunRow(store, 'jr_c').status).toBe('pending')
    } finally {
      store.close()
    }
  })

  test('takes over a claimed run with an expired lease, but NOT one with a still-valid lease', () => {
    const store = createInMemoryJobsStore()
    try {
      seedJobRun(store, {
        jobRunId: 'jr_expired',
        triggeredAt: '2026-04-23T11:00:00.000Z',
        status: 'claimed',
        leaseOwner: 'old',
        leaseExpiresAt: '2026-04-23T11:59:00.000Z',
      })
      seedJobRun(store, {
        jobRunId: 'jr_valid',
        triggeredAt: '2026-04-23T11:00:00.000Z',
        status: 'claimed',
        leaseOwner: 'holder',
        leaseExpiresAt: '2026-04-23T12:30:00.000Z',
      })

      const { jobRuns } = store.claimDueJobRuns({
        now: '2026-04-23T12:00:00.000Z',
        limit: 10,
        leaseOwner: 'owner:2',
        leaseExpiresAt: '2026-04-23T12:05:00.000Z',
      })

      expect(jobRuns.map((r) => r.jobRunId)).toEqual(['jr_expired'])
      expect(readJobRunRow(store, 'jr_expired').lease_owner).toBe('owner:2')
      // Still-valid lease untouched.
      expect(readJobRunRow(store, 'jr_valid').lease_owner).toBe('holder')
    } finally {
      store.close()
    }
  })

  test('returns an empty list when nothing is claimable', () => {
    const store = createInMemoryJobsStore()
    try {
      const { jobRuns } = store.claimDueJobRuns({
        now: '2026-04-23T12:00:00.000Z',
        limit: 10,
        leaseOwner: 'owner:1',
        leaseExpiresAt: '2026-04-23T12:05:00.000Z',
      })
      expect(jobRuns).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('characterization: claimPendingInboxEvents (event_inbox claim-and-lease loop)', () => {
  test('claims a pending event, increments attempts, sets lease columns, returns the record array', () => {
    const store = createInMemoryJobsStore()
    try {
      seedInboxEvent(store, 'a', 1)

      const claimed = store.claimPendingInboxEvents({
        now: 'now-ts',
        limit: 10,
        leaseOwner: 'me',
        leaseExpiresAt: 'later-ts',
      })

      // Returned shape: InboxEventRecord[] directly (no wrapper object).
      expect(Array.isArray(claimed)).toBe(true)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]).toEqual(
        expect.objectContaining({
          eventId: 'wrkq:a',
          status: 'leased',
          leaseOwner: 'me',
          leaseExpiresAt: 'later-ts',
          attempts: 1,
        })
      )

      const row = readInboxRow(store, 'wrkq:a')
      expect(row.status).toBe('leased')
      expect(row.lease_owner).toBe('me')
      expect(row.lease_expires_at).toBe('later-ts')
      expect(row.attempts).toBe(1)
      expect(row.updated_at).toBe('now-ts')
    } finally {
      store.close()
    }
  })

  test('orders candidates by event_seq ASC and respects the limit', () => {
    const store = createInMemoryJobsStore()
    try {
      seedInboxEvent(store, 'b', 2)
      seedInboxEvent(store, 'a', 1)
      seedInboxEvent(store, 'c', 3)

      const claimed = store.claimPendingInboxEvents({
        now: 'now-ts',
        limit: 2,
        leaseOwner: 'me',
        leaseExpiresAt: 'later-ts',
      })

      expect(claimed.map((e) => e.eventId)).toEqual(['wrkq:a', 'wrkq:b'])
      // The third (highest seq) remains pending.
      expect(readInboxRow(store, 'wrkq:c').status).toBe('pending')
    } finally {
      store.close()
    }
  })

  test('default limit (no input.limit) claims available pending events', () => {
    const store = createInMemoryJobsStore()
    try {
      seedInboxEvent(store, 'a', 1)
      seedInboxEvent(store, 'b', 2)

      const claimed = store.claimPendingInboxEvents({
        now: 'now-ts',
        leaseOwner: 'me',
        leaseExpiresAt: 'later-ts',
      })

      expect(claimed.map((e) => e.eventId)).toEqual(['wrkq:a', 'wrkq:b'])
    } finally {
      store.close()
    }
  })

  test('takes over a leased event with an expired lease and increments attempts again', () => {
    const store = createInMemoryJobsStore()
    try {
      seedInboxEvent(store, 'a', 1)
      // First claim leases it (attempts → 1).
      store.claimPendingInboxEvents({
        now: 'first-ts',
        leaseOwner: 'owner-1',
        leaseExpiresAt: '2026-04-23T11:00:00.000Z',
      })

      // Second claim with now past the lease expiry: takeover, attempts → 2.
      const claimed = store.claimPendingInboxEvents({
        now: '2026-04-23T12:00:00.000Z',
        leaseOwner: 'owner-2',
        leaseExpiresAt: '2026-04-23T12:30:00.000Z',
      })

      expect(claimed.map((e) => e.eventId)).toEqual(['wrkq:a'])
      const row = readInboxRow(store, 'wrkq:a')
      expect(row.lease_owner).toBe('owner-2')
      expect(row.attempts).toBe(2)
    } finally {
      store.close()
    }
  })

  test('does NOT re-claim a leased event whose lease is still valid', () => {
    const store = createInMemoryJobsStore()
    try {
      seedInboxEvent(store, 'a', 1)
      store.claimPendingInboxEvents({
        now: '2026-04-23T12:00:00.000Z',
        leaseOwner: 'owner-1',
        leaseExpiresAt: '2026-04-23T12:30:00.000Z',
      })

      const claimed = store.claimPendingInboxEvents({
        now: '2026-04-23T12:05:00.000Z',
        leaseOwner: 'owner-2',
        leaseExpiresAt: '2026-04-23T12:35:00.000Z',
      })

      expect(claimed).toEqual([])
      const row = readInboxRow(store, 'wrkq:a')
      expect(row.lease_owner).toBe('owner-1')
      expect(row.attempts).toBe(1)
    } finally {
      store.close()
    }
  })

  test('returns an empty array when nothing is claimable', () => {
    const store = createInMemoryJobsStore()
    try {
      const claimed = store.claimPendingInboxEvents({
        now: 'now-ts',
        leaseOwner: 'me',
        leaseExpiresAt: 'later-ts',
      })
      expect(claimed).toEqual([])
    } finally {
      store.close()
    }
  })
})
