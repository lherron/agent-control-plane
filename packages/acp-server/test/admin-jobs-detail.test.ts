import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { withWiredServer } from './fixtures/wired-server.js'

function createBaseJobInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'agent-spaces',
    agentId: 'larry',
    scopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'inspect job' },
    ...overrides,
  }
}

describe('admin job detail endpoint', () => {
  test('omits flow for input-only jobs', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const job = jobsStore.createJob(createBaseJobInput()).job

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${job.jobId}/detail`,
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            job: { jobId: string }
            summary: { kind: string; flowStepCount: number; onFailureStepCount: number }
            startup: { scopeRef: string; input: Record<string, unknown> }
            flow?: unknown
          }>(response)

          expect(payload.job.jobId).toBe(job.jobId)
          expect(payload.summary).toEqual(
            expect.objectContaining({
              kind: 'input',
              flowStepCount: 0,
              onFailureStepCount: 0,
            })
          )
          expect(payload.startup).toEqual(
            expect.objectContaining({
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01412',
              input: { content: 'inspect job' },
            })
          )
          expect(payload.flow).toBeUndefined()
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('normalizes flow nodes and edges', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const job = jobsStore.createJob(
            createBaseJobInput({
              flow: {
                sequence: [
                  { id: 'collect', input: 'collect context' },
                  {
                    id: 'test',
                    kind: 'exec',
                    exec: { argv: ['bun', 'test'] },
                    branches: { exitCode: { '0': 'implement' }, default: 'fail' },
                  },
                  { id: 'implement', input: 'apply change', next: 'succeed' },
                ],
                onFailure: [{ id: 'report', input: 'report failure' }],
              },
            })
          ).job

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${job.jobId}/detail`,
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            flow: {
              nodes: Array<{ id: string; phase: string; index: number }>
              sequence: Array<{ id: string }>
              onFailure: Array<{ id: string }>
              edges: Array<{ from: string; to: string; label: string }>
              warnings: string[]
            }
          }>(response)

          expect(payload.flow.nodes).toHaveLength(4)
          expect(payload.flow.sequence.map((step) => step.id)).toEqual([
            'collect',
            'test',
            'implement',
          ])
          expect(payload.flow.onFailure.map((step) => step.id)).toEqual(['report'])
          expect(payload.flow.edges).toContainEqual({
            from: 'collect',
            to: 'test',
            label: 'continue',
          })
          expect(payload.flow.edges).toContainEqual({
            from: 'test',
            to: 'implement',
            label: 'continue',
          })
          expect(payload.flow.edges).toContainEqual({
            from: 'test',
            to: 'fail',
            label: 'fail',
          })
          expect(payload.flow.edges).toContainEqual({
            from: 'collect',
            to: 'report',
            label: 'onFailure',
          })
          expect(payload.flow.warnings).toEqual([])
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('reports warnings for dangling next targets', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const job = jobsStore.createJob(
            createBaseJobInput({
              flow: {
                sequence: [{ id: 'collect', input: 'collect context', next: 'missing' }],
              },
            })
          ).job

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${job.jobId}/detail`,
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{ flow: { warnings: string[] } }>(response)

          expect(payload.flow.warnings).toContain(
            'sequence.collect.next points to missing sequence step: missing'
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('truncates latestRuns to ten records', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const job = jobsStore.createJob(createBaseJobInput()).job
          for (let index = 0; index < 12; index += 1) {
            jobsStore.appendJobRun({
              jobId: job.jobId,
              jobRunId: `jrun_${String(index).padStart(2, '0')}`,
              triggeredAt: `2026-05-11T00:${String(index).padStart(2, '0')}:00.000Z`,
              triggeredBy: 'manual',
              status: 'succeeded',
            })
          }

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${job.jobId}/detail`,
          })
          expect(response.status).toBe(200)
          const payload = await fixture.json<{
            latestRuns: Array<{ jobRunId: string }>
            lineage: { jobRuns: Array<{ jobRunId: string }> }
          }>(response)

          expect(payload.latestRuns).toHaveLength(10)
          expect(payload.latestRuns[0]?.jobRunId).toBe('jrun_11')
          expect(payload.latestRuns.at(-1)?.jobRunId).toBe('jrun_02')
          expect(payload.lineage.jobRuns).toHaveLength(10)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
