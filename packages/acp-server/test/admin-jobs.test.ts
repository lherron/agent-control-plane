import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryJobsStore } from 'acp-jobs-store'

import { type AcpServerDeps, InMemoryInputAttemptStore } from '../src/index.js'
import { advanceJobFlow } from '../src/jobs/flow-engine.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]
type WiredServerOverrides = Partial<Omit<AcpServerDeps, 'wrkqStore' | 'coordStore'>> & {
  hrcDbPath?: string | undefined
}

type FlowLaunchOutcome =
  | { status: 'completed' | 'failed' | 'cancelled'; text?: string | undefined }
  | { status: 'running' }

type HeadlessHrcFixture = {
  db: Database
  hrcDbPath: string
  cleanup(): void
}

function serverOverrides(
  overrides: WiredServerOverrides
): Partial<Omit<AcpServerDeps, 'wrkqStore' | 'coordStore'>> {
  return overrides
}

class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
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

function createHeadlessHrcDb(): HeadlessHrcFixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-admin-jobs-flow-'))
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)

  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      event_json TEXT NOT NULL
    );
  `)

  return {
    db,
    hrcDbPath,
    cleanup() {
      db.close()
      rmSync(fixtureDir, { recursive: true, force: true })
    },
  }
}

function insertHrcRun(
  hrc: HeadlessHrcFixture,
  hrcRunId: string,
  outcome: Exclude<FlowLaunchOutcome, { status: 'running' }>
): void {
  hrc.db.run(
    'INSERT INTO runs (run_id, status, error_code, error_message) VALUES (?, ?, NULL, NULL)',
    hrcRunId,
    outcome.status
  )

  if (outcome.text !== undefined) {
    hrc.db.run(
      'INSERT INTO events (run_id, event_kind, event_json) VALUES (?, ?, ?)',
      hrcRunId,
      'message_end',
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: outcome.text }],
        },
      })
    )
  }
}

function createFlowLaunchOverrides(
  hrc: HeadlessHrcFixture,
  outcomes: FlowLaunchOutcome[],
  calls: LaunchCall[] = [],
  order: string[] = []
): Partial<AcpServerDeps> {
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
      order.push('dispatch')
      const acpRunId = input.acpRunId
      if (acpRunId === undefined) {
        throw new Error('expected acpRunId for flow step dispatch')
      }

      const outcome = outcomes.shift() ?? { status: 'completed', text: 'RESULT\n{}' }
      const hrcRunId = `hrc-${acpRunId}`
      if (outcome.status === 'running') {
        input.runStore?.updateRun(acpRunId, {
          status: 'running',
          hrcRunId,
          hostSessionId: 'hsid-flow',
        })
      } else {
        insertHrcRun(hrc, hrcRunId, outcome)
        input.runStore?.updateRun(acpRunId, {
          status: outcome.status,
          hrcRunId,
          hostSessionId: 'hsid-flow',
        })
      }

      return {
        runId: hrcRunId,
        sessionId: 'hsid-flow',
      }
    },
  }
}

async function createJob(
  fixture: Parameters<typeof withWiredServer>[0] extends (fixture: infer T) => unknown ? T : never,
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
      schedule: { cron: '*/5 * * * *' },
      input: { content: 'run the jobs workflow' },
      ...overrides,
    },
  })

  expect(response.status).toBe(201)
  return fixture.json<{ job: { jobId: string } }>(response)
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

async function createJobRun(
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

describe('admin jobs routes', () => {
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

  test('GET /v1/admin/jobs lists jobs and supports projectId filtering', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          await createJob(fixture)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/admin/jobs?projectId=${fixture.seed.projectId}`,
          })
          const payload = await fixture.json<{ jobs: Array<{ projectId: string }> }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobs).not.toHaveLength(0)
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

  test('POST /v1/admin/jobs/:jobId/run creates a manual job-run and dispatches through /inputs', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)

          const response = await fixture.request({
            method: 'POST',
            path: `/v1/admin/jobs/${created.job.jobId}/run`,
          })
          expect(response.status).toBe(202)
          const payload = await fixture.json<{
            jobRun: {
              jobRunId: string
              jobId: string
              triggeredBy: string
              status: string
              inputAttemptId: string
              runId: string
            }
          }>(response)

          expect(payload.jobRun).toEqual(
            expect.objectContaining({
              jobRunId: expect.any(String),
              jobId: created.job.jobId,
              triggeredBy: 'manual',
              status: expect.stringMatching(/dispatched|succeeded|running|pending/),
              inputAttemptId: expect.any(String),
              runId: expect.any(String),
            })
          )
          expect(launchCalls).toHaveLength(1)
          expect(launchCalls[0]).toEqual(
            expect.objectContaining({
              inputAttemptId: payload.jobRun.inputAttemptId,
              acpRunId: payload.jobRun.runId,
            })
          )
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

  test('POST /v1/admin/jobs/:jobId/run advances a flow through terminal sequence steps', async () => {
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
        },
        serverOverrides({
          jobsStore,
          inputAttemptStore,
          hrcDbPath: hrc.hrcDbPath,
          ...createFlowLaunchOverrides(
            hrc,
            [
              { status: 'completed', text: 'RESULT\n{"step":"collect","ready":true}' },
              { status: 'completed', text: 'RESULT\n{"step":"implement","ready":true}' },
            ],
            launchCalls
          ),
        })
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
        serverOverrides({
          jobsStore,
          hrcDbPath: hrc.hrcDbPath,
          hrcClient: {
            resolveSession: async (request: unknown) => {
              order.push('resolveSession')
              hrcCalls.push({ method: 'resolveSession', request })
              return { hostSessionId: 'hsid-fresh' }
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
        })
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
            jobRun: { status: string; errorCode: string }
            steps: Array<{
              phase: string
              stepId: string
              status: string
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
        },
        serverOverrides({
          jobsStore,
          hrcDbPath: hrc.hrcDbPath,
          ...createFlowLaunchOverrides(hrc, [
            { status: 'completed', text: 'RESULT\n{"ready":true}' },
            { status: 'completed', text: 'RESULT\n{"ready":false}' },
            { status: 'completed', text: 'CLEANUP\n{"notified":true}' },
          ]),
        })
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
        serverOverrides({
          jobsStore,
          hrcDbPath: hrc.hrcDbPath,
          ...createFlowLaunchOverrides(hrc, [
            { status: 'completed', text: 'No structured result was provided.' },
          ]),
        })
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
              hrcDbPath: hrc.hrcDbPath,
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
        serverOverrides({
          jobsStore,
          hrcDbPath: hrc.hrcDbPath,
          ...flowLaunchOverrides,
        })
      )
    } finally {
      hrc.cleanup()
      jobsStore.close()
    }
  })

  test('GET /v1/jobs/:jobId/runs lists job-runs for a job', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          await createJobRun(fixture, created.job.jobId)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/jobs/${created.job.jobId}/runs`,
          })
          const payload = await fixture.json<{ jobRuns: Array<{ jobId: string }> }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRuns).not.toHaveLength(0)
          expect(payload.jobRuns.every((jobRun) => jobRun.jobId === created.job.jobId)).toBe(true)
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('GET /v1/job-runs/:jobRunId returns one correlated job-run', async () => {
    const jobsStore = createInMemoryJobsStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const createdRun = await createJobRun(fixture, created.job.jobId)

          const response = await fixture.request({
            method: 'GET',
            path: `/v1/job-runs/${createdRun.jobRun.jobRunId}`,
          })
          const payload = await fixture.json<{
            jobRun: { jobRunId: string; jobId: string; inputAttemptId: string; runId: string }
          }>(response)

          expect(response.status).toBe(200)
          expect(payload.jobRun).toEqual(
            expect.objectContaining({
              jobRunId: createdRun.jobRun.jobRunId,
              jobId: created.job.jobId,
              inputAttemptId: createdRun.jobRun.inputAttemptId,
              runId: createdRun.jobRun.runId,
            })
          )
        },
        { jobsStore }
      )
    } finally {
      jobsStore.close()
    }
  })

  test('manual run dispatch records job source metadata exactly once on the input attempt', async () => {
    const jobsStore = createInMemoryJobsStore()
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()

    try {
      await withWiredServer(
        async (fixture) => {
          const created = await createJob(fixture)
          const payload = await createJobRun(fixture, created.job.jobId)

          expect(inputAttemptStore.calls).toHaveLength(1)
          expect(inputAttemptStore.calls[0]).toEqual(
            expect.objectContaining({
              metadata: expect.objectContaining({
                source: {
                  kind: 'job',
                  jobId: created.job.jobId,
                  jobRunId: payload.jobRun.jobRunId,
                },
              }),
            })
          )
          expect(launchCalls).toHaveLength(1)
        },
        {
          jobsStore,
          inputAttemptStore,
          ...createLaunchOverrides(launchCalls),
        }
      )
    } finally {
      jobsStore.close()
    }
  })
})
