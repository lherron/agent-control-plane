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

function listColumns(store: ReturnType<typeof createInMemoryJobsStore>, tableName: string): string[] {
  const escapedTableName = tableName.replaceAll('"', '""')
  return (
    store.sqlite.prepare(`PRAGMA table_info("${escapedTableName}")`).all() as SqliteColumnRow[]
  ).map((row) => row.name)
}

function hasAnyColumn(columns: readonly string[], aliases: readonly string[]): boolean {
  return aliases.some((alias) => columns.includes(alias))
}

function findJobsTable(store: ReturnType<typeof createInMemoryJobsStore>): {
  tableName: string
  columns: string[]
} | null {
  const requiredColumnAliases = [
    ['job_id', 'jobId'],
    ['scope_ref', 'scopeRef'],
    ['lane_ref', 'laneRef'],
    ['schedule', 'schedule_json', 'schedule_cron', 'cron'],
    ['input', 'input_json', 'input_template', 'input_content'],
    ['enabled', 'disabled'],
    ['created_at', 'createdAt'],
    ['updated_at', 'updatedAt'],
  ] as const

  for (const tableName of listUserTables(store)) {
    const columns = listColumns(store, tableName)
    if (requiredColumnAliases.every((aliases) => hasAnyColumn(columns, aliases))) {
      return { tableName, columns }
    }
  }

  return null
}

function resolveJobsCrud(store: ReturnType<typeof createInMemoryJobsStore>): {
  create: (...args: unknown[]) => unknown
  list: (...args: unknown[]) => unknown
  get: (...args: unknown[]) => unknown
  update: (...args: unknown[]) => unknown
  archive: (...args: unknown[]) => unknown
} {
  const root = store as unknown as Record<string, unknown>
  const nested =
    typeof root['jobs'] === 'object' && root['jobs'] !== null
      ? (root['jobs'] as Record<string, unknown>)
      : undefined

  const create =
    root['createJob'] ?? nested?.['create'] ?? nested?.['createJob'] ?? nested?.['insert']
  const list = root['listJobs'] ?? nested?.['list'] ?? nested?.['listJobs']
  const get = root['getJob'] ?? nested?.['get'] ?? nested?.['getJob']
  const update = root['updateJob'] ?? nested?.['update'] ?? nested?.['updateJob']
  const archive =
    root['archiveJob'] ??
    root['deleteJob'] ??
    nested?.['archive'] ??
    nested?.['archiveJob'] ??
    nested?.['delete']

  expect(typeof create).toBe('function')
  expect(typeof list).toBe('function')
  expect(typeof get).toBe('function')
  expect(typeof update).toBe('function')
  expect(typeof archive).toBe('function')

  return {
    create: create as (...args: unknown[]) => unknown,
    list: list as (...args: unknown[]) => unknown,
    get: get as (...args: unknown[]) => unknown,
    update: update as (...args: unknown[]) => unknown,
    archive: archive as (...args: unknown[]) => unknown,
  }
}

function unwrapJob(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && 'job' in value) {
    return (value as { job: Record<string, unknown> }).job
  }

  return value as Record<string, unknown>
}

function unwrapJobList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value as Record<string, unknown>[]
  }
  if (typeof value === 'object' && value !== null && 'jobs' in value) {
    return (value as { jobs: Record<string, unknown>[] }).jobs
  }

  return []
}

describe('jobs store contract', () => {
  test('creates a durable jobs table for schedules, targets, and lifecycle state', () => {
    const store = createInMemoryJobsStore()

    try {
      const jobsTable = findJobsTable(store)

      expect(jobsTable).not.toBeNull()
      expect(jobsTable?.columns ?? []).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/job/i),
          expect.stringMatching(/scope/i),
          expect.stringMatching(/schedule|cron/i),
          expect.stringMatching(/input/i),
        ])
      )
    } finally {
      store.close()
    }
  })

  test('supports create, list, get, patch, and soft-archive job flows', async () => {
    const store = createInMemoryJobsStore()

    try {
      const jobs = resolveJobsCrud(store)
      const created = unwrapJob(
        await Promise.resolve(
          jobs.create({
            agentId: 'larry',
            projectId: 'demo-project',
            scopeRef: 'agent:larry:project:demo-project:task:T-01175:role:implementer',
            laneRef: 'nightly',
            schedule: {
              cron: '*/5 * * * *',
              windowMinutes: 15,
            },
            input: {
              content: 'run the jobs acceptance suite',
            },
            disabled: false,
          })
        )
      )

      const jobId = created['jobId']
      expect(typeof jobId).toBe('string')
      expect(created['disabled'] ?? created['enabled']).toBe(false)

      const listed = unwrapJobList(await Promise.resolve(jobs.list({ projectId: 'demo-project' })))
      expect(listed).toEqual(
        expect.arrayContaining([expect.objectContaining({ jobId, laneRef: 'nightly' })])
      )

      const fetched = unwrapJob(await Promise.resolve(jobs.get(jobId)))
      expect(fetched).toEqual(expect.objectContaining({ jobId, projectId: 'demo-project' }))

      const patched = unwrapJob(
        await Promise.resolve(
          jobs.update(jobId, {
            disabled: true,
            schedule: {
              cron: '0 * * * *',
            },
          })
        )
      )
      expect(patched).toEqual(
        expect.objectContaining({
          jobId,
          disabled: true,
          schedule: expect.objectContaining({ cron: '0 * * * *' }),
        })
      )

      await Promise.resolve(jobs.archive(jobId))
      const afterArchive = unwrapJobList(await Promise.resolve(jobs.list({ projectId: 'demo-project' })))
      expect(afterArchive.map((job) => job['jobId'])).not.toContain(jobId)
    } finally {
      store.close()
    }
  })
})
