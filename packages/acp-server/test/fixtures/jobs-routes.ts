import { expect } from 'bun:test'
import type { WiredServerFixture } from './wired-server.js'

export async function createJob(
  fixture: WiredServerFixture,
  overrides: Record<string, unknown> = {}
): Promise<{ job: { jobId: string } }> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/admin/jobs',
    body: {
      agentId: 'larry',
      projectId: fixture.seed.projectId,
      scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer`,
      laneRef: 'main',
      trigger: { kind: 'event', source: 'wrkq', match: { event: 'created' } },
      input: { content: 'run the jobs workflow' },
      ...overrides,
    },
  })

  expect(response.status).toBe(201)
  return fixture.json<{ job: { jobId: string } }>(response)
}

export async function createJobRun(
  fixture: WiredServerFixture,
  jobId: string
): Promise<{ jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string } }> {
  const response = await fixture.request({
    method: 'POST',
    path: `/v1/admin/jobs/${jobId}/run`,
  })

  expect(response.status).toBe(202)
  return fixture.json<{
    jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string }
  }>(response)
}
