import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

const VALID_FLOW = {
  sequence: [{ id: 'work', input: 'do it' }],
}

describe('admin jobs — slug + description', () => {
  test('POST /v1/admin/jobs auto-populates slug from jobId when omitted', async () => {
    const jobsStore = createInMemoryJobsStore()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:default-slug`,
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'x' },
            },
          })
          expect(response.status).toBe(201)
          const { job } = await fixture.json<{ job: { jobId: string; slug: string } }>(response)
          expect(job.slug).toBe(job.jobId)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close?.()
    }
  })

  test('POST /v1/admin/jobs accepts a valid slug + description and round-trips them', async () => {
    const jobsStore = createInMemoryJobsStore()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              slug: 'nightly.learning-curation',
              description: 'Picks the next curation candidate and writes a summary.',
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:curation`,
              schedule: { cron: '0 3 * * *' },
              input: { content: 'x' },
              flow: VALID_FLOW,
            },
          })
          expect(response.status).toBe(201)
          const { job } = await fixture.json<{
            job: { jobId: string; slug: string; description?: string }
          }>(response)
          expect(job.slug).toBe('nightly.learning-curation')
          expect(job.description).toBe('Picks the next curation candidate and writes a summary.')

          const detail = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${job.jobId}/detail`,
          })
          expect(detail.status).toBe(200)
          const detailBody = await fixture.json<{
            summary: { title: string; description?: string }
          }>(detail)
          expect(detailBody.summary.title).toBe('nightly.learning-curation')
          expect(detailBody.summary.description).toBe(
            'Picks the next curation candidate and writes a summary.'
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close?.()
    }
  })

  test('POST /v1/admin/jobs rejects a slug that fails the regex', async () => {
    const jobsStore = createInMemoryJobsStore()
    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              slug: 'Bad Slug!',
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:bad`,
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'x' },
            },
          })
          expect(response.status).toBe(400)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close?.()
    }
  })

  test('POST /v1/admin/jobs rejects a duplicate slug within the same project', async () => {
    const jobsStore = createInMemoryJobsStore()
    try {
      await withWiredServer(
        async (fixture) => {
          const body = {
            agentId: 'larry',
            projectId: fixture.seed.projectId,
            slug: 'dup-slug',
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:a`,
            schedule: { cron: '*/5 * * * *' },
            input: { content: 'x' },
          }
          const first = await fixture.request({ method: 'POST', path: '/v1/admin/jobs', body })
          expect(first.status).toBe(201)

          const dup = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              ...body,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:b`,
            },
          })
          // The unique index raises; the server should not 201 it.
          expect(dup.status).not.toBe(201)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close?.()
    }
  })

  test('PATCH /v1/admin/jobs/:jobId can update slug and description', async () => {
    const jobsStore = createInMemoryJobsStore()
    try {
      await withWiredServer(
        async (fixture) => {
          const created = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              slug: 'initial-slug',
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:p`,
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'x' },
            },
          })
          expect(created.status).toBe(201)
          const { job } = await fixture.json<{ job: { jobId: string } }>(created)

          const patched = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${job.jobId}`,
            body: { slug: 'renamed-slug', description: 'Now with explanation.' },
          })
          expect(patched.status).toBe(200)
          const patchedBody = await fixture.json<{
            job: { slug: string; description?: string }
          }>(patched)
          expect(patchedBody.job.slug).toBe('renamed-slug')
          expect(patchedBody.job.description).toBe('Now with explanation.')

          const cleared = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${job.jobId}`,
            body: { description: null },
          })
          expect(cleared.status).toBe(200)
          const clearedBody = await fixture.json<{ job: { description?: string } }>(cleared)
          expect(clearedBody.job.description).toBeUndefined()
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close?.()
    }
  })
})
