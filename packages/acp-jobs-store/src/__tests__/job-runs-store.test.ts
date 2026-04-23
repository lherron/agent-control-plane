import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

type SqliteTableRow = { name: string }
type SqliteColumnRow = { name: string }

function listUserTables(store: ReturnType<typeof createInMemoryJobsStore>): string[] {
  return (
    store.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as SqliteTableRow[]
  ).map((row) => row.name)
}

function listColumns(
  store: ReturnType<typeof createInMemoryJobsStore>,
  tableName: string
): string[] {
  const escapedTableName = tableName.replaceAll('"', '""')
  return (
    store.sqlite.prepare(`PRAGMA table_info("${escapedTableName}")`).all() as SqliteColumnRow[]
  ).map((row) => row.name)
}

function hasAnyColumn(columns: readonly string[], aliases: readonly string[]): boolean {
  return aliases.some((alias) => columns.includes(alias))
}

function findJobRunsTable(store: ReturnType<typeof createInMemoryJobsStore>): {
  tableName: string
  columns: string[]
} | null {
  const requiredColumnAliases = [
    ['job_run_id', 'jobRunId'],
    ['job_id', 'jobId'],
    ['triggered_at', 'triggeredAt'],
    ['triggered_by', 'triggeredBy'],
    ['status'],
    ['input_attempt_id', 'inputAttemptId'],
    ['run_id', 'runId'],
    ['error_code', 'errorCode'],
    ['error_message', 'errorMessage'],
  ] as const

  for (const tableName of listUserTables(store)) {
    const columns = listColumns(store, tableName)
    if (requiredColumnAliases.every((aliases) => hasAnyColumn(columns, aliases))) {
      return { tableName, columns }
    }
  }

  return null
}

function resolveJobRunsApi(store: ReturnType<typeof createInMemoryJobsStore>): {
  append: (...args: unknown[]) => unknown
  listByJob: (...args: unknown[]) => unknown
  get: (...args: unknown[]) => unknown
  claimDueRuns: (...args: unknown[]) => unknown
} {
  const root = store as unknown as Record<string, unknown>
  const nested =
    typeof root['jobRuns'] === 'object' && root['jobRuns'] !== null
      ? (root['jobRuns'] as Record<string, unknown>)
      : undefined

  const append =
    root['appendJobRun'] ?? nested?.['append'] ?? nested?.['create'] ?? nested?.['appendJobRun']
  const listByJob =
    root['listJobRuns'] ??
    root['listJobRunsByJob'] ??
    nested?.['list'] ??
    nested?.['listByJob'] ??
    nested?.['listJobRuns']
  const get = root['getJobRun'] ?? nested?.['get'] ?? nested?.['getJobRun']
  const claimDueRuns =
    root['claimDueJobRuns'] ??
    root['leaseAndClaimDueJobRuns'] ??
    nested?.['claimDue'] ??
    nested?.['claimDueJobRuns'] ??
    nested?.['leaseAndClaim']

  expect(typeof append).toBe('function')
  expect(typeof listByJob).toBe('function')
  expect(typeof get).toBe('function')
  expect(typeof claimDueRuns).toBe('function')

  return {
    append: append as (...args: unknown[]) => unknown,
    listByJob: listByJob as (...args: unknown[]) => unknown,
    get: get as (...args: unknown[]) => unknown,
    claimDueRuns: claimDueRuns as (...args: unknown[]) => unknown,
  }
}

function unwrapJobRun(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && 'jobRun' in value) {
    return (value as { jobRun: Record<string, unknown> }).jobRun
  }

  return value as Record<string, unknown>
}

function unwrapJobRunList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value as Record<string, unknown>[]
  }
  if (typeof value === 'object' && value !== null) {
    if ('jobRuns' in value) {
      return (value as { jobRuns: Record<string, unknown>[] }).jobRuns
    }
    if ('runs' in value) {
      return (value as { runs: Record<string, unknown>[] }).runs
    }
  }

  return []
}

describe('job-runs store contract', () => {
  test('creates a durable job-runs table with trigger, claim, and correlation fields', () => {
    const store = createInMemoryJobsStore()

    try {
      const jobRunsTable = findJobRunsTable(store)

      expect(jobRunsTable).not.toBeNull()
      expect(jobRunsTable?.columns ?? []).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/job/i),
          expect.stringMatching(/trigger/i),
          expect.stringMatching(/status/i),
          expect.stringMatching(/run/i),
        ])
      )
    } finally {
      store.close()
    }
  })

  test('supports append, list, get, and lease-then-claim flows for due job-runs', async () => {
    const store = createInMemoryJobsStore()

    try {
      const jobRuns = resolveJobRunsApi(store)
      const appended = unwrapJobRun(
        await Promise.resolve(
          jobRuns.append({
            jobId: 'job_01175',
            jobRunId: 'jrun_01175',
            triggeredAt: '2026-04-23T12:00:00.000Z',
            triggeredBy: 'manual',
            status: 'pending',
          })
        )
      )

      expect(appended).toEqual(
        expect.objectContaining({
          jobId: 'job_01175',
          jobRunId: 'jrun_01175',
          triggeredBy: 'manual',
          status: 'pending',
        })
      )

      const listed = unwrapJobRunList(await Promise.resolve(jobRuns.listByJob('job_01175')))
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jobRunId: 'jrun_01175', jobId: 'job_01175' }),
        ])
      )

      const fetched = unwrapJobRun(await Promise.resolve(jobRuns.get('jrun_01175')))
      expect(fetched).toEqual(expect.objectContaining({ jobRunId: 'jrun_01175' }))

      const claimed = unwrapJobRunList(
        await Promise.resolve(
          jobRuns.claimDueRuns({
            now: '2026-04-23T12:00:00.000Z',
            limit: 10,
            leaseOwner: 'scheduler:test',
            leaseExpiresAt: '2026-04-23T12:05:00.000Z',
          })
        )
      )
      expect(claimed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jobRunId: 'jrun_01175',
            status: expect.stringMatching(/claimed|dispatched/i),
          }),
        ])
      )
    } finally {
      store.close()
    }
  })
})
