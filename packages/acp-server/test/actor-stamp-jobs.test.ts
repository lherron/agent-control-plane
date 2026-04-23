import { describe, expect, test } from 'bun:test'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function readActor(record: Record<string, unknown>): unknown {
  return record['actor']
}

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      return {
        runId: input.acpRunId ?? 'run-launch-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

async function createJob(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never,
  input: { headers?: HeadersInit | undefined; body?: Record<string, unknown> | undefined }
): Promise<{ response: Response; jobId: string }> {
  const response = await fixture.request({
    method: 'POST',
    path: '/v1/admin/jobs',
    headers: input.headers,
    body: {
      agentId: 'larry',
      projectId: fixture.seed.projectId,
      scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01184:role:implementer`,
      laneRef: 'main',
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'run the jobs workflow' },
      ...(input.body ?? {}),
    },
  })
  const payload = await fixture.json<{ job: { jobId: string } }>(response)
  return { response, jobId: payload.job.jobId }
}

describe('actor-stamp: jobs', () => {
  test('prefers X-ACP-Actor over body actor when creating a job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {
            headers: { 'x-acp-actor': 'agent:curly' },
            body: { actor: { kind: 'human', id: 'body-operator' } },
          })

          expect(created.response.status).toBe(201)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${created.jobId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ job: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.job)).toEqual({ kind: 'agent', id: 'curly' })
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('falls back to the body actor when creating a job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {
            body: { actor: { kind: 'human', id: 'body-operator' } },
          })

          expect(created.response.status).toBe(201)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${created.jobId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ job: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.job)).toEqual({ kind: 'human', id: 'body-operator' })
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('falls back to the default system actor when creating a job without an actor', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {})

          expect(created.response.status).toBe(201)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs/${created.jobId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ job: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.job)).toEqual({ kind: 'system', id: 'acp-local' })
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('prefers X-ACP-Actor over body actor when creating a job-run', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {})
          expect(created.response.status).toBe(201)

          const runResponse = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.jobId}/run`,
            headers: { 'x-acp-actor': 'agent:curly' },
            body: { actor: { kind: 'human', id: 'body-operator' } },
          })

          expect(runResponse.status).toBe(202)
          const runPayload = await fixture.json<{ jobRun: { jobRunId: string } }>(runResponse)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${runPayload.jobRun.jobRunId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ jobRun: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.jobRun)).toEqual({ kind: 'agent', id: 'curly' })
        },
        {
          jobsStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('falls back to the body actor when creating a job-run', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {})
          expect(created.response.status).toBe(201)

          const runResponse = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.jobId}/run`,
            body: { actor: { kind: 'human', id: 'body-operator' } },
          })

          expect(runResponse.status).toBe(202)
          const runPayload = await fixture.json<{ jobRun: { jobRunId: string } }>(runResponse)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${runPayload.jobRun.jobRunId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ jobRun: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.jobRun)).toEqual({ kind: 'human', id: 'body-operator' })
        },
        {
          jobsStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('falls back to the default system actor when creating a job-run without an actor', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {})
          expect(created.response.status).toBe(201)

          const runResponse = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.jobId}/run`,
          })

          expect(runResponse.status).toBe(202)
          const runPayload = await fixture.json<{ jobRun: { jobRunId: string } }>(runResponse)
          const getResponse = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${runPayload.jobRun.jobRunId}`,
          })

          expect(getResponse.status).toBe(200)
          const payload = await fixture.json<{ jobRun: Record<string, unknown> }>(getResponse)
          expect(readActor(payload.jobRun)).toEqual({ kind: 'system', id: 'acp-local' })
        },
        {
          jobsStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })
})
