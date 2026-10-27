import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from '../index.js'

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
  test('a job can be created, listed, patched, and archived out of the list', async () => {
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
      const afterArchive = unwrapJobList(
        await Promise.resolve(jobs.list({ projectId: 'demo-project' }))
      )
      expect(afterArchive.map((job) => job['jobId'])).not.toContain(jobId)
    } finally {
      store.close()
    }
  })

  test('round-trips flow definitions without changing legacy input content', () => {
    const store = createInMemoryJobsStore()

    try {
      const legacy = store.createJob({
        agentId: 'larry',
        projectId: 'demo-project',
        scopeRef: 'agent:larry:project:demo-project',
        schedule: { cron: '0 * * * *' },
        input: { content: 'legacy prompt' },
      }).job

      expect(legacy.input).toEqual({ content: 'legacy prompt' })
      expect('flow' in legacy).toBe(false)

      const flow = {
        sequence: [{ id: 'work', input: 'Do the work.' }],
      }
      const created = store.createJob({
        agentId: 'larry',
        projectId: 'demo-project',
        scopeRef: 'agent:larry:project:demo-project',
        schedule: { cron: '0 * * * *' },
        input: { content: 'legacy compatibility prompt' },
        flow,
      }).job

      expect(created.flow).toEqual(flow)
      expect(created.input).toEqual({ content: 'legacy compatibility prompt' })
      expect(store.getJob(created.jobId).job?.flow).toEqual(flow)
      expect(
        store.listJobs({ projectId: 'demo-project' }).jobs.map((job) => job.flow)
      ).toContainEqual(flow)
    } finally {
      store.close()
    }
  })
})
