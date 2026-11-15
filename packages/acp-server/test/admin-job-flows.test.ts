import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import { createInMemoryJobsStore } from 'acp-jobs-store'
import type { AcpServerDeps } from '../src/index.js'
import { advanceJobFlow } from '../src/jobs/flow-engine.js'
import {
  RecordingInputAttemptStore,
  createFlowLauncher,
  createHeadlessHrcDb,
  insertHrcRun,
} from './fixtures/flow-engine.js'
import { type LaunchCall, admissionRuntime } from './fixtures/input-admission.js'
import { createJob } from './fixtures/jobs-routes.js'
import { withWiredServer } from './fixtures/wired-server.js'

function createFlowLaunchOverrides(
  ...args: Parameters<typeof createFlowLauncher>
): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => admissionRuntime(),
    launchRoleScopedRun: createFlowLauncher(...args),
  }
}

function createResultBlockFlow() {
  return {
    sequence: [
      {
        id: 'collect',
        input: 'collect project context',
        expect: { resultBlock: 'RESULT', equals: { step: 'collect', ready: true } },
      },
      {
        id: 'implement',
        input: 'apply the requested change',
        expect: { resultBlock: 'RESULT', equals: { step: 'implement', ready: true } },
      },
    ],
  }
}

describe('admin job flow execution', () => {
  test('POST /v1/admin/jobs/:jobId/run advances a flow through terminal sequence steps', async () => {
    const adminStore = createInMemoryAdminStore()
    const jobsStore = createInMemoryJobsStore()
    const hrc = createHeadlessHrcDb()
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, { flow: createResultBlockFlow() })

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            jobRun: { jobRunId: string; status: string }
            steps: Array<{ stepId: string; status: string; result?: Record<string, unknown> }>
          }>(response)

          expect(response.status).toBe(202)
          expect(payload.jobRun.status).toBe('succeeded')
          expect(payload.steps.map((step) => [step.stepId, step.status])).toEqual([
            ['collect', 'succeeded'],
            ['implement', 'succeeded'],
          ])
          expect(payload.steps[0]?.result).toEqual({ step: 'collect', ready: true })
          expect(payload.steps[1]?.result).toEqual({ step: 'implement', ready: true })
          expect(inputAttemptStore.calls.map((call) => call.idempotencyKey)).toEqual([
            `jobrun:${payload.jobRun.jobRunId}:phase:sequence:step:collect:attempt:1`,
            `jobrun:${payload.jobRun.jobRunId}:phase:sequence:step:implement:attempt:1`,
          ])
          expect(launchCalls).toHaveLength(2)
          const firstStepAttemptId = launchCalls[0]?.inputAttemptId
          const attemptResponse = await fixture.request({
            method: 'GET',
            path: `/v1/input-attempts/${firstStepAttemptId}`,
          })
          expect(attemptResponse.status).toBe(200)
          const attempt = await fixture.json<{
            inputAttempt: { idempotencyKey?: string; metadata?: Record<string, unknown> }
          }>(attemptResponse)
          expect(attempt.inputAttempt.idempotencyKey).toBe(
            `jobrun:${payload.jobRun.jobRunId}:phase:sequence:step:collect:attempt:1`
          )
          expect(attempt.inputAttempt.metadata?.['source']).toEqual({
            kind: 'job',
            jobId: created.job.jobId,
            jobRunId: payload.jobRun.jobRunId,
            stepId: 'collect',
            phase: 'sequence',
            attempt: 1,
          })
          const completed = adminStore.systemEvents.list({ kind: 'job.completed' })
          expect(completed).toHaveLength(1)
          expect(completed[0]?.payload['finalResponse']).toBe(
            'RESULT\n{"step":"implement","ready":true}'
          )
        },
        {
          adminStore,
          jobsStore,
          inputAttemptStore,
          hrcRoutes: hrc.hrcRoutes,
          ...createFlowLaunchOverrides(
            hrc,
            [
              { status: 'completed', text: 'RESULT\n{"step":"collect","ready":true}' },
              { status: 'completed', text: 'RESULT\n{"step":"implement","ready":true}' },
            ],
            launchCalls
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('flow fresh steps clear HRC continuation before first dispatch only', async () => {
    const jobsStore = createInMemoryJobsStore()
    const hrc = createHeadlessHrcDb()
    const order: string[] = []
    const hrcCalls: Array<{ method: string; request: unknown }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {
            flow: {
              sequence: [
                { id: 'fresh-start', input: 'start with a fresh context', fresh: true },
                { id: 'explicit-continue', input: 'continue normally', fresh: false },
                { id: 'implicit-continue', input: 'continue normally' },
              ],
            },
          })

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            jobRun: { status: string }
            steps: Array<{ stepId: string; status: string }>
          }>(response)

          expect(response.status).toBe(202)
          expect(payload.jobRun.status).toBe('succeeded')
          expect(payload.steps.map((step) => [step.stepId, step.status])).toEqual([
            ['fresh-start', 'succeeded'],
            ['explicit-continue', 'succeeded'],
            ['implicit-continue', 'succeeded'],
          ])
          expect(order).toEqual([
            'resolveSession',
            'clearContext',
            'dispatch',
            'dispatch',
            'dispatch',
          ])
          expect(hrcCalls).toEqual([
            {
              method: 'resolveSession',
              request: {
                sessionRef: `agent:larry:project:${fixture.seed.projectId}:task:T-01175:role:implementer/lane:main`,
              },
            },
            {
              method: 'clearContext',
              request: { hostSessionId: 'hsid-fresh', dropContinuation: true },
            },
          ])
        },
        {
          jobsStore,
          hrcRoutes: hrc.hrcRoutes,
          hrcClient: {
            resolveSession: async (request: unknown) => {
              order.push('resolveSession')
              hrcCalls.push({ method: 'resolveSession', request })
              return { found: true, hostSessionId: 'hsid-fresh' }
            },
            clearContext: async (request: unknown) => {
              order.push('clearContext')
              hrcCalls.push({ method: 'clearContext', request })
              return {
                hostSessionId: 'hsid-fresh',
                generation: 2,
                priorHostSessionId: 'hsid-previous',
              }
            },
          } as never,
          ...createFlowLaunchOverrides(
            hrc,
            [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }],
            [],
            order
          ),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('flow sequence failure skips remaining sequence steps and runs onFailure', async () => {
    const jobsStore = createInMemoryJobsStore()
    const hrc = createHeadlessHrcDb()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {
            flow: {
              sequence: [
                {
                  id: 'collect',
                  input: 'collect project context',
                  expect: { resultBlock: 'RESULT', equals: { ready: true } },
                },
                {
                  id: 'implement',
                  input: 'apply the requested change',
                  expect: { resultBlock: 'RESULT', equals: { ready: true } },
                },
                { id: 'deploy', input: 'deploy the change' },
              ],
              onFailure: [
                {
                  id: 'cleanup',
                  input: 'summarize the failed step',
                  expect: { resultBlock: 'CLEANUP', equals: { notified: true } },
                },
              ],
            },
          })

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            jobRun: { jobRunId: string; status: string; errorCode: string }
            steps: Array<{
              phase: string
              stepId: string
              status: string
              inputAttemptId?: string
              error?: { code: string }
            }>
          }>(response)

          expect(response.status).toBe(202)
          expect(payload.jobRun.status).toBe('failed')
          expect(payload.jobRun.errorCode).toBe('result_field_mismatch')
          expect(payload.steps.map((step) => [step.phase, step.stepId, step.status])).toEqual([
            ['sequence', 'collect', 'succeeded'],
            ['sequence', 'implement', 'failed'],
            ['sequence', 'deploy', 'skipped'],
            ['onFailure', 'cleanup', 'succeeded'],
          ])
          expect(payload.steps.find((step) => step.stepId === 'implement')?.error?.code).toBe(
            'result_field_mismatch'
          )

          const cleanup = payload.steps.find((step) => step.stepId === 'cleanup')
          const attemptResponse = await fixture.request({
            method: 'GET',
            path: `/v1/input-attempts/${cleanup?.inputAttemptId}`,
          })
          expect(attemptResponse.status).toBe(200)
          const attempt = await fixture.json<{ inputAttempt: { idempotencyKey?: string } }>(
            attemptResponse
          )
          expect(attempt.inputAttempt.idempotencyKey).toBe(
            `jobrun:${payload.jobRun.jobRunId}:phase:onFailure:step:cleanup:attempt:1`
          )
        },
        {
          jobsStore,
          hrcRoutes: hrc.hrcRoutes,
          ...createFlowLaunchOverrides(hrc, [
            { status: 'completed', text: 'RESULT\n{"ready":true}' },
            { status: 'completed', text: 'RESULT\n{"ready":false}' },
            { status: 'completed', text: 'CLEANUP\n{"notified":true}' },
          ]),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('flow step fails with result_block_missing when terminal output lacks expected block', async () => {
    const jobsStore = createInMemoryJobsStore()
    const hrc = createHeadlessHrcDb()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, {
            flow: {
              sequence: [
                {
                  id: 'collect',
                  input: 'collect project context',
                  expect: { resultBlock: 'RESULT', equals: { ready: true } },
                },
              ],
            },
          })

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            jobRun: { status: string; errorCode: string }
            steps: Array<{ stepId: string; status: string; error?: { code: string } }>
          }>(response)

          expect(response.status).toBe(202)
          expect(payload.jobRun.status).toBe('failed')
          expect(payload.jobRun.errorCode).toBe('result_block_missing')
          expect(payload.steps).toEqual([
            expect.objectContaining({
              stepId: 'collect',
              status: 'failed',
              error: expect.objectContaining({ code: 'result_block_missing' }),
            }),
          ])
        },
        {
          jobsStore,
          hrcRoutes: hrc.hrcRoutes,
          ...createFlowLaunchOverrides(hrc, [
            { status: 'completed', text: 'No structured result was provided.' },
          ]),
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('flow manual run returns after dispatching a non-terminal first step and resumes later', async () => {
    const jobsStore = createInMemoryJobsStore()
    const hrc = createHeadlessHrcDb()
    const flowLaunchOverrides = createFlowLaunchOverrides(hrc, [
      { status: 'running' },
      { status: 'completed', text: 'RESULT\n{"step":"implement","ready":true}' },
    ])

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture, { flow: createResultBlockFlow() })

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          const payload = await fixture.json<{
            jobRun: { jobRunId: string; status: string }
            steps: Array<{ stepId: string; status: string; runId?: string }>
          }>(response)

          expect(response.status).toBe(202)
          expect(payload.jobRun.status).toBe('running')
          expect(payload.steps.map((step) => [step.stepId, step.status])).toEqual([
            ['collect', 'running'],
            ['implement', 'pending'],
          ])

          const firstRunId = payload.steps[0]?.runId
          expect(firstRunId).toEqual(expect.any(String))
          fixture.runStore.updateRun(firstRunId!, { status: 'completed' })
          insertHrcRun(hrc, `hrc-${firstRunId}`, {
            status: 'completed',
            text: 'RESULT\n{"step":"collect","ready":true}',
          })

          const job = jobsStore.getJob(created.job.jobId).job
          const jobRun = jobsStore.getJobRun(payload.jobRun.jobRunId).jobRun
          if (job === undefined || jobRun === undefined) {
            throw new Error('expected persisted flow job and job run')
          }

          const advanced = await advanceJobFlow({
            deps: {
              ...fixture,
              jobsStore,
              hrcRoutes: hrc.hrcRoutes,
              ...flowLaunchOverrides,
              defaultActor: { kind: 'system', id: 'test' },
              authorize: () => 'allow',
              presetRegistry: {
                getPreset: () => {
                  throw new Error('not needed')
                },
              },
            } as never,
            job,
            jobRun,
            actor: { kind: 'system', id: 'test' },
          })

          expect(advanced.status).toBe('succeeded')
          expect(
            jobsStore.jobStepRuns
              .listByJobRun(jobRun.jobRunId)
              .jobStepRuns.map((step) => [step.stepId, step.status])
          ).toEqual([
            ['collect', 'succeeded'],
            ['implement', 'succeeded'],
          ])
        },
        {
          jobsStore,
          hrcRoutes: hrc.hrcRoutes,
          ...flowLaunchOverrides,
        }
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })
})
