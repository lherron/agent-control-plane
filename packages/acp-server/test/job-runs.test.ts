import { describe, expect, test } from 'bun:test'

import { type JobsStore, createInMemoryJobsStore } from 'acp-jobs-store'

import type { AcpServerDeps } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

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

async function createLegacyJob(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never
): Promise<{ job: { jobId: string } }> {
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
    },
  })

  expect(response.status).toBe(201)
  return fixture.json<{ job: { jobId: string } }>(response)
}

async function createLegacyJobRun(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never,
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

/**
 * Create a flow job and job-run directly in the store, bypassing the API
 * dispatch path (which requires the full flow engine). This lets us test
 * the GET handler in isolation.
 */
function createFlowJobAndRun(
  store: JobsStore,
  projectId: string,
  options?: { status?: 'pending' | 'claimed' | 'dispatched' | 'succeeded' | 'failed' | 'skipped' }
): { jobId: string; jobRunId: string } {
  const { job } = store.createJob({
    agentId: 'larry',
    projectId,
    scopeRef: `agent:larry:project:${projectId}:task:T-01175:role:implementer`,
    laneRef: 'main',
    schedule: { cron: '*/5 * * * *' },
    input: { content: 'run the jobs workflow' },
    flow: createFlow(),
    actor: { kind: 'system', id: 'test' },
  })

  const now = new Date().toISOString()
  const { jobRun } = store.appendJobRun({
    jobId: job.jobId,
    triggeredAt: now,
    triggeredBy: 'manual',
    status: options?.status ?? 'claimed',
    claimedAt: now,
    actor: { kind: 'system', id: 'test' },
  })

  return { jobId: job.jobId, jobRunId: jobRun.jobRunId }
}

describe('GET /v1/job-runs/:jobRunId', () => {
  test('legacy job-run (no flow) returns current shape unchanged', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createLegacyJob(fixture)
          const createdRun = await createLegacyJobRun(fixture, created.job.jobId)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${createdRun.jobRun.jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: {
              jobRunId: string
              jobId: string
              status: string
              inputAttemptId: string
              runId: string
              steps?: unknown
            }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun.jobRunId).toBe(createdRun.jobRun.jobRunId)
          expect(payload.jobRun.jobId).toBe(created.job.jobId)
          expect(payload.jobRun.inputAttemptId).toBe(createdRun.jobRun.inputAttemptId)
          expect(payload.jobRun.runId).toBe(createdRun.jobRun.runId)
          // Legacy uses internal status strings (dispatched, pending, etc.)
          expect(payload.jobRun.status).toMatch(
            /^(pending|claimed|dispatched|succeeded|failed|skipped)$/
          )
          // No steps[] on legacy
          expect(payload.jobRun.steps).toBeUndefined()
        },
        { jobsStore, ...createLaunchOverrides(launchCalls) }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('flow job-run returns steps[] in correct order and uses spec status strings', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const { jobRunId } = createFlowJobAndRun(jobsStore, fixture.seed.projectId)

          // Seed step-runs like the flow engine would
          jobsStore.insertJobStepRuns(jobRunId, 'sequence', [
            { stepId: 'collect', attempt: 1 },
            { stepId: 'implement', attempt: 1 },
          ])
          jobsStore.insertJobStepRuns(jobRunId, 'onFailure', [{ stepId: 'cleanup', attempt: 1 }])

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: {
              jobRunId: string
              status: string
              steps: Array<{
                stepId: string
                phase: string
                status: string
                attempt: number
              }>
            }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun.jobRunId).toBe(jobRunId)

          // Flow jobs use spec status strings: queued|running|succeeded|failed
          expect(payload.jobRun.status).toMatch(/^(queued|running|succeeded|failed)$/)

          // Steps present and ordered: sequence first, then onFailure
          expect(payload.jobRun.steps).toHaveLength(3)
          expect(payload.jobRun.steps[0].stepId).toBe('collect')
          expect(payload.jobRun.steps[0].phase).toBe('sequence')
          expect(payload.jobRun.steps[1].stepId).toBe('implement')
          expect(payload.jobRun.steps[1].phase).toBe('sequence')
          expect(payload.jobRun.steps[2].stepId).toBe('cleanup')
          expect(payload.jobRun.steps[2].phase).toBe('onFailure')
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('flow job-run maps internal pending status to queued', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const { jobRunId } = createFlowJobAndRun(jobsStore, fixture.seed.projectId, {
            status: 'pending',
          })

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: { status: string; steps: unknown[] }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun.status).toBe('queued')
          expect(payload.jobRun.steps).toEqual([])
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('flow job-run step includes optional fields when present', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const { jobRunId } = createFlowJobAndRun(jobsStore, fixture.seed.projectId)

          // Insert a step run with optional fields populated
          jobsStore.insertJobStepRuns(jobRunId, 'sequence', [{ stepId: 'collect', attempt: 1 }])
          jobsStore.updateJobStepRun(jobRunId, 'sequence', 'collect', 1, {
            status: 'succeeded',
            inputAttemptId: 'ia-001',
            runId: 'run-001',
            result: { summary: 'done' },
            resultBlock: 'block-001',
            startedAt: '2026-04-27T00:00:00Z',
            completedAt: '2026-04-27T00:01:00Z',
          })

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: {
              steps: Array<{
                stepId: string
                inputAttemptId?: string
                runId?: string
                result?: unknown
                resultBlock?: string
                startedAt?: string
                completedAt?: string
              }>
            }
          }>(response)

          expect(response.status).toBe(200)
          const step = payload.jobRun.steps[0]
          expect(step.stepId).toBe('collect')
          expect(step.inputAttemptId).toBe('ia-001')
          expect(step.runId).toBe('run-001')
          expect(step.result).toEqual({ summary: 'done' })
          expect(step.resultBlock).toBe('block-001')
          expect(step.startedAt).toBe('2026-04-27T00:00:00Z')
          expect(step.completedAt).toBe('2026-04-27T00:01:00Z')
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('flow job-run preserves full exec result in steps[]', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const { jobRunId } = createFlowJobAndRun(jobsStore, fixture.seed.projectId)
          const execResult = {
            kind: 'exec',
            argv: ['node', '-e', 'process.stdout.write("ok")'],
            cwd: '/tmp/work',
            exitCode: 0,
            stdout: `stdout-${'x'.repeat(120)}`,
            stderr: 'stderr-line',
            stdoutTruncated: false,
            stderrTruncated: true,
            timedOut: false,
            durationMs: 42,
            startedAt: '2026-04-28T12:00:00.000Z',
            completedAt: '2026-04-28T12:00:00.042Z',
          }

          jobsStore.insertJobStepRuns(jobRunId, 'sequence', [{ stepId: 'collect', attempt: 1 }])
          jobsStore.updateJobStepRun(jobRunId, 'sequence', 'collect', 1, {
            status: 'succeeded',
            result: execResult,
          })

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: { steps: Array<{ stepId: string; result?: unknown }> }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun.steps[0]).toEqual(
            expect.objectContaining({
              stepId: 'collect',
              result: execResult,
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })
})
