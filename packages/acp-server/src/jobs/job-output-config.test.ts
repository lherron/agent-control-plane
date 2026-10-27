import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from '../../test/fixtures/wired-server.js'

const SINK = { kind: 'webhook', url: 'http://127.0.0.1:18551/api' }

type JobResponse = { job: { jobId: string; output?: Record<string, unknown> } }
type ErrorResponse = { error: { code: string; message: string; details?: Record<string, unknown> } }

async function postJobWithOutput(output: unknown) {
  const jobsStore = createInMemoryJobsStore()
  try {
    return await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/jobs',
          body: {
            agentId: 'larry',
            projectId: fixture.seed.projectId,
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-10005`,
            laneRef: 'main',
            trigger: {
              kind: 'event',
              source: 'media-ingest',
              match: { event: 'transcript.completed' },
            },
            input: { content: 'summarize' },
            output,
          },
        })
        const body = await fixture.json<JobResponse & ErrorResponse>(response)
        if (response.status !== 201) return { status: response.status, body }
        const read = await fixture.request({
          method: 'GET',
          path: `/v1/admin/jobs/${body.job.jobId}`,
        })
        return { status: response.status, body, read: await fixture.json<JobResponse>(read) }
      },
      { jobsStore }
    )
  } finally {
    jobsStore.close()
  }
}

describe('POST /v1/admin/jobs output delivery policy (T-10005)', () => {
  test.each([
    {
      name: 'a valid output.delivery policy is stored and returned unchanged',
      output: { sinks: [SINK], delivery: { maxAttempts: 5, maxAgeSeconds: 3600 } },
    },
    {
      name: 'sinks without a delivery policy are stored with no delivery key',
      output: { sinks: [SINK] },
    },
  ])('$name', async ({ output }) => {
    const result = await postJobWithOutput(output)

    expect(result.status).toBe(201)
    expect(result.body.job.output).toEqual(output)
    expect(result.read?.job.output).toEqual(output)
  })

  test.each([
    [{ sinks: [SINK], retries: 3 }, 'output.retries is not supported'],
    [
      { sinks: [SINK], delivery: { maxAttempts: 0 } },
      'output.delivery.maxAttempts must be an integer from 1 to 1000',
    ],
    [
      { sinks: [SINK], delivery: { maxAttempts: 2.5 } },
      'output.delivery.maxAttempts must be an integer from 1 to 1000',
    ],
    [
      { sinks: [SINK], delivery: { maxAgeSeconds: 59 } },
      'output.delivery.maxAgeSeconds must be an integer from 60 to 604800',
    ],
    [{ sinks: [SINK], delivery: { backoff: 'fast' } }, 'output.delivery.backoff is not supported'],
    [{ sinks: [SINK], delivery: 'soon' }, 'output.delivery must be an object'],
  ] as const)(
    'an invalid output config %j is refused with 400 naming %s',
    async (output, error) => {
      const result = await postJobWithOutput(output)

      expect(result.status).toBe(400)
      expect(result.body.error.message).toContain(error)
      expect(result.body.error.details).toMatchObject({ field: 'output' })
    }
  )
})
