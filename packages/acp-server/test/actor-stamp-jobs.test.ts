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
      bundle: { kind: 'compose', compose: [] },
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

const ACTOR_ROWS = [
  {
    name: 'header beats body',
    headers: { 'x-acp-actor': 'agent:curly' },
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'agent', id: 'curly' },
  },
  {
    name: 'body without header',
    headers: undefined,
    bodyActor: { kind: 'human', id: 'body-operator' },
    expected: { kind: 'human', id: 'body-operator' },
  },
  {
    name: 'neither falls back to the default system actor',
    headers: undefined,
    bodyActor: undefined,
    expected: { kind: 'system', id: 'acp-local' },
  },
] as const

function actorBody(row: (typeof ACTOR_ROWS)[number]): Record<string, unknown> {
  return row.bodyActor !== undefined ? { actor: row.bodyActor } : {}
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
    for (const row of ACTOR_ROWS) {
      const jobsStore = createInMemoryJobsStore()

      try {
        await withWiredServer(
          async (fixture) => {
            const created = await createJob(fixture, {
              headers: row.headers,
              body: actorBody(row),
            })

            expect(created.response.status, row.name).toBe(201)
            const getResponse = await fixture.request({
              method: 'GET',
              path: `/v1/admin/jobs/${created.jobId}`,
            })

            expect(getResponse.status, row.name).toBe(200)
            const payload = await fixture.json<{ job: Record<string, unknown> }>(getResponse)
            expect(readActor(payload.job), row.name).toEqual(row.expected)
          },
          { jobsStore }
        )
      } finally {
        jobsStore.close()
      }
    }
  })

  test('prefers X-ACP-Actor over body actor when creating a job-run', async () => {
    for (const row of ACTOR_ROWS) {
      const jobsStore = createInMemoryJobsStore()
      const launchCalls: LaunchCall[] = []

      try {
        await withWiredServer(
          async (fixture) => {
            const created = await createJob(fixture, {})
            expect(created.response.status, row.name).toBe(201)

            const runResponse = await fixture.request({
              method: 'POST',
              path: `/v1/admin/jobs/${created.jobId}/run`,
              headers: row.headers,
              ...(row.bodyActor !== undefined ? { body: actorBody(row) } : {}),
            })

            expect(runResponse.status, row.name).toBe(202)
            const runPayload = await fixture.json<{ jobRun: { jobRunId: string } }>(runResponse)
            const getResponse = await fixture.request({
              method: 'GET',
              path: `/v1/job-runs/${runPayload.jobRun.jobRunId}`,
            })

            expect(getResponse.status, row.name).toBe(200)
            const payload = await fixture.json<{ jobRun: Record<string, unknown> }>(getResponse)
            expect(readActor(payload.jobRun), row.name).toEqual(row.expected)
          },
          {
            jobsStore,
            ...createLaunchOverrides(launchCalls),
          }
        )
      } finally {
        jobsStore.close()
      }
    }
  })
})
