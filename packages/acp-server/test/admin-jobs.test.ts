import { describe, expect, test } from 'bun:test'
import { createInMemoryJobsStore } from 'acp-jobs-store'
import { createJob } from './fixtures/jobs-routes.js'
import { withWiredServer } from './fixtures/wired-server.js'

function createFlow() {
  return {
    sequence: [
      {
        id: 'collect',
        input: 'collect project context',
        timeout: 'PT5M',
        expect: { outcome: 'succeeded', require: ['summary'] },
      },
      {
        id: 'implement',
        input: 'apply the requested change',
        expect: { equals: { ready: true } },
      },
    ],
    onFailure: [{ id: 'cleanup', input: 'summarize the failed step' }],
  }
}

describe('admin job definitions', () => {
  test('POST /v1/admin/jobs creates a durable scheduled job', async () => {
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
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
              laneRef: 'main',
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'run the jobs workflow' },
              disabled: false,
            },
          })
          const payload = await fixture.json<{
            job: {
              jobId: string
              projectId: string
              schedule: { cron: string }
              input: { content: string }
              disabled: boolean
            }
          }>(response)

          expect(response.status).toBe(201)
          expect(payload.job).toEqual(
            expect.objectContaining({
              jobId: expect.stringMatching(/^job_/),
              projectId: fixture.seed.projectId,
              schedule: expect.objectContaining({ cron: '*/5 * * * *' }),
              input: expect.objectContaining({ content: 'run the jobs workflow' }),
              disabled: false,
            })
          )
          expect('flow' in payload.job).toBe(false)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('POST /v1/admin/jobs round-trips a flow definition through create, show, and list', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const flow = createFlow()
          const response = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
              laneRef: 'main',
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'run the jobs workflow' },
              flow,
            },
          })
          const created = await fixture.json<{ job: { jobId: string; flow: unknown } }>(response)

          expect(response.status).toBe(201)
          expect(created.job.flow).toEqual(flow)

          const showResponse = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${created.job.jobId}`,
          })
          const shown = await fixture.json<{ job: { jobId: string; flow: unknown } }>(showResponse)

          expect(showResponse.status).toBe(200)
          expect(shown.job.flow).toEqual(flow)

          const listResponse = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs?projectId=${fixture.seed.projectId}`,
          })
          const listed = await fixture.json<{ jobs: Array<{ jobId: string; flow?: unknown }> }>(
            listResponse
          )

          expect(listResponse.status).toBe(200)
          expect(listed.jobs.find((job) => job.jobId === created.job.jobId)?.flow).toEqual(flow)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('POST and PATCH reject freshDuration flow steps on event-triggered jobs', async () => {
    const jobsStore = createInMemoryJobsStore()
    const freshDurationFlow = {
      sequence: [{ id: 'fresh', input: 'Start fresh.', fresh: true, freshDuration: 'PT24H' }],
    }

    try {
      await withWiredServer(
        async (fixture) => {
          const createResponse = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
              laneRef: 'main',
              trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
              input: { content: 'run the jobs workflow' },
              flow: freshDurationFlow,
            },
          })
          const createPayload = await fixture.json<{
            valid: false
            errors: Array<{ code: string }>
          }>(createResponse)

          expect(createResponse.status).toBe(400)
          expect(createPayload.errors.map((error) => error.code)).toContain(
            'invalid_fresh_duration'
          )
          expect(jobsStore.listJobs({ projectId: fixture.seed.projectId }).jobs).toHaveLength(0)

          const created = await createJob(fixture, { flow: freshDurationFlow })
          const patchResponse = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${created.job.jobId}`,
            body: {
              trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
            },
          })
          const patchPayload = await fixture.json<{
            valid: false
            errors: Array<{ code: string }>
          }>(patchResponse)

          expect(patchResponse.status).toBe(400)
          expect(patchPayload.errors.map((error) => error.code)).toContain('invalid_fresh_duration')

          const stored = jobsStore.getJob(created.job.jobId).job
          expect(stored?.trigger.kind).toBe('schedule')
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/admin/jobs lists jobs and supports projectId filtering', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          jobsStore.createJob({
            projectId: 'other-project',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:other-project',
            laneRef: 'main',
            schedule: { cron: '*/5 * * * *' },
            input: { content: 'job in another project' },
          })

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs?projectId=${fixture.seed.projectId}`,
          })
          const payload = await fixture.json<{ jobs: Array<{ jobId: string; projectId: string }> }>(
            response
          )

          expect(response.status).toBe(200)
          expect(payload.jobs.map((job) => job.jobId)).toEqual([created.job.jobId])
          expect(payload.jobs.every((job) => job.projectId === fixture.seed.projectId)).toBe(true)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('PATCH /v1/admin/jobs/:jobId updates schedule and disabled state', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)

          const response = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${created.job.jobId}`,
            body: {
              schedule: { cron: '0 * * * *' },
              disabled: true,
            },
          })
          const payload = await fixture.json<{
            job: { jobId: string; schedule: { cron: string }; disabled: boolean }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.job).toEqual(
            expect.objectContaining({
              jobId: created.job.jobId,
              schedule: expect.objectContaining({ cron: '0 * * * *' }),
              disabled: true,
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('PATCH /v1/admin/jobs/:jobId round-trips a flow patch without changing legacy fields', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const flow = createFlow()

          const response = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${created.job.jobId}`,
            body: { flow },
          })
          const payload = await fixture.json<{
            job: { jobId: string; flow: unknown; input: { content: string } }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.job).toEqual(
            expect.objectContaining({
              jobId: created.job.jobId,
              flow,
              input: expect.objectContaining({ content: 'run the jobs workflow' }),
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('POST /v1/admin/jobs/validate returns validator envelopes without persisting jobs', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const validResponse = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs/validate',
            body: {
              projectId: fixture.seed.projectId,
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'run the jobs workflow' },
              flow: createFlow(),
            },
          })

          expect(validResponse.status).toBe(200)
          expect(await fixture.json(validResponse)).toEqual({ valid: true })

          const cases: Array<{ body: Record<string, unknown>; code: string }> = [
            { body: { flow: { sequence: [] } }, code: 'empty_sequence' },
            {
              body: {
                flow: {
                  sequence: [
                    { id: 'work', input: 'one' },
                    { id: 'work', input: 'two' },
                  ],
                },
              },
              code: 'duplicate_step_id',
            },
            {
              body: { flow: { sequence: [{ id: 'missing' }] } },
              code: 'missing_step_input',
            },
            {
              body: { flow: { sequence: [{ id: 'both', input: 'x', inputFile: 'prompt.md' }] } },
              code: 'ambiguous_step_input',
            },
            {
              body: { flow: { sequence: [{ id: 'file', inputFile: 'prompt.md' }] } },
              code: 'input_file_not_allowed',
            },
            {
              body: { flow: { sequence: [{ id: 'expect', input: 'x', expect: { json: true } }] } },
              code: 'unsupported_expect_field',
            },
            {
              body: { flow: createFlow(), schedule: { cron: 'not-cron' } },
              code: 'invalid_cron',
            },
            {
              body: { flow: { sequence: [{ id: 'timeout', input: 'x', timeout: 'soon' }] } },
              code: 'invalid_timeout',
            },
          ]

          for (const validationCase of cases) {
            const response = await fixture.request({
              method: 'POST',
              path: '/v1/admin/jobs/validate',
              body: validationCase.body,
            })
            const payload = await fixture.json<{
              valid: false
              errors: Array<{ code: string; path: string; message: string }>
            }>(response)

            expect(response.status).toBe(200)
            expect(payload.valid).toBe(false)
            expect(payload.errors.map((error) => error.code)).toContain(validationCase.code)
          }

          expect(jobsStore.listJobs({ projectId: fixture.seed.projectId }).jobs).toHaveLength(0)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('POST /v1/admin/jobs/validate returns 400 for malformed JSON', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.handler(
            new Request('http://acp.test/v1/admin/jobs/validate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{',
            })
          )
          const payload = await fixture.json<{ error: { code: string } }>(response)

          expect(response.status).toBe(400)
          expect(payload.error.code).toBe('malformed_request')
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('POST and PATCH /v1/admin/jobs reject server-side flow inputFile', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const flowWithInputFile = { sequence: [{ id: 'file', inputFile: 'prompt.md' }] }
          const createResponse = await fixture.request({
            method: 'POST',
            path: '/v1/admin/jobs',
            body: {
              agentId: 'larry',
              projectId: fixture.seed.projectId,
              scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
              laneRef: 'main',
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'run the jobs workflow' },
              flow: flowWithInputFile,
            },
          })
          const createPayload = await fixture.json<{
            valid: false
            errors: Array<{ code: string }>
          }>(createResponse)

          expect(createResponse.status).toBe(400)
          expect(createPayload.errors.map((error) => error.code)).toContain(
            'input_file_not_allowed'
          )

          const created = await createJob(fixture)
          const patchResponse = await fixture.request({
            method: 'PATCH',
            path: `/v1/admin/jobs/${created.job.jobId}`,
            body: { flow: flowWithInputFile },
          })
          const patchPayload = await fixture.json<{
            valid: false
            errors: Array<{ code: string }>
          }>(patchResponse)

          expect(patchResponse.status).toBe(400)
          expect(patchPayload.errors.map((error) => error.code)).toContain('input_file_not_allowed')
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
