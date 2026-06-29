import { describe, expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'

import { main } from '../cli.js'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type FetchExpectation = {
  status?: number | undefined
  body?: unknown
  assert(request: {
    url: string
    method: string
    headers: Headers
    body: unknown
  }): void
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, target: string[]): void {
  if (typeof chunk === 'string') {
    target.push(chunk)
    return
  }

  const view = chunk as ArrayBufferView
  target.push(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8'))
}

async function runCli(
  args: string[],
  options: {
    fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
    env?: NodeJS.ProcessEnv | undefined
    createWorkClient?: (() => Promise<WorkClient>) | undefined
  } = {}
): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdout)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderr)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.createWorkClient !== undefined
        ? { createWorkClient: options.createWorkClient }
        : {}),
    })
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: error.code }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }
}

function createFakeWorkClient(input: {
  taskId: string
  projectUuid: string
  projectId: string
}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  return {
    calls,
    async createWorkClient(): Promise<WorkClient> {
      return {
        wrkq: {
          task: {
            async show(params: { task: string }) {
              calls.push({ method: 'wrkq.task.show', params })
              expect(params).toEqual({ task: input.taskId })
              return { id: input.taskId, projectUuid: input.projectUuid }
            },
          },
          container: {
            async show(params: { project: string }) {
              calls.push({ method: 'wrkq.container.show', params })
              expect(params).toEqual({ project: input.projectUuid })
              return { id: input.projectId }
            },
          },
        },
        async close() {
          calls.push({ method: 'close' })
        },
      } as unknown as WorkClient
    },
  }
}

function createFetchQueue(expectations: FetchExpectation[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []

  return {
    calls,
    async fetchImpl(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const text = await request.text()
      const body =
        text.length === 0
          ? undefined
          : (() => {
              try {
                return JSON.parse(text) as unknown
              } catch {
                return text
              }
            })()

      const recorded = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }
      calls.push(recorded)

      const expectation = expectations.shift()
      if (expectation === undefined) {
        throw new Error(`unexpected fetch for ${request.method} ${request.url}`)
      }

      expectation.assert(recorded)
      return new Response(
        expectation.body === undefined ? null : JSON.stringify(expectation.body),
        {
          status: expectation.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    },
  }
}

describe('acp CLI smoke fixtures', () => {
  test('top-level help exposes usage without pinning full prose', async () => {
    const result = await runCli(['--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/usage:\s+acp/i)
    expect(result.stdout).toContain('task')
    expect(result.stdout).toContain('action')
    expect(result.stdout).toContain('message')
  })

  test('action triage help documents idempotency and wrkq project resolution', async () => {
    const result = await runCli(['action', 'triage', '--help'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('acp action triage')
    expect(result.stdout).not.toContain('--project')
    expect(result.stdout).toContain('--force')
    expect(result.stdout).toMatch(/idempotency key/i)
    expect(result.stdout).toMatch(/duplicate HRC run/i)
  })

  test('action triage posts exact governed launch body by default', async () => {
    const workClient = createFakeWorkClient({
      taskId: 'T-20001',
      projectUuid: 'project-uuid-agent-spaces',
      projectId: 'agent-spaces',
    })
    const fetchQueue = createFetchQueue([
      {
        body: {
          source: 'wrkf-action',
          taskId: 'T-20001',
          actionRunId: 'act-1',
          wrkfRunId: 'wrun-1',
          externalRunRef: 'hrc:hrc-1',
          hrcRunId: 'hrc-1',
          replay: false,
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/wrkf/actions/launch')
          expect(request.headers.get('x-acp-actor-agent-id')).toBe('smokey')
          expect(Object.keys(request.body as Record<string, unknown>).sort()).toEqual([
            'action',
            'idempotencyKey',
            'sessionRef',
            'taskId',
          ])
          expect(request.body).toEqual({
            taskId: 'T-20001',
            action: 'triage',
            idempotencyKey: 'task:T-20001:action:triage',
            sessionRef: {
              scopeRef: 'agent:clod:project:agent-spaces:task:T-20001',
              laneRef: 'main',
            },
          })
        },
      },
    ])

    const result = await runCli(['action', 'triage', 'T-20001', '--actor', 'smokey', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
      createWorkClient: workClient.createWorkClient,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      actionRunId: 'act-1',
      wrkfRunId: 'wrun-1',
      externalRunRef: 'hrc:hrc-1',
      hrcRunId: 'hrc-1',
      replay: false,
      cli: {
        action: 'triage',
        taskId: 'T-20001',
        projectId: 'agent-spaces',
        idempotencyKey: 'task:T-20001:action:triage',
        forced: false,
      },
    })
    expect(fetchQueue.calls).toHaveLength(1)
    expect(workClient.calls.map((call) => call.method)).toEqual([
      'wrkq.task.show',
      'wrkq.container.show',
      'close',
    ])
  })

  test('action triage resolves project from @wrkq/client when launching', async () => {
    const workClient = createFakeWorkClient({
      taskId: 'T-20002',
      projectUuid: 'project-uuid-wrkq',
      projectId: 'wrkq',
    })
    const fetchQueue = createFetchQueue([
      {
        body: { actionRunId: 'act-env', wrkfRunId: 'wrun-env', replay: false },
        assert(request) {
          expect(request.body).toMatchObject({
            sessionRef: {
              scopeRef: 'agent:clod:project:wrkq:task:T-20002',
              laneRef: 'main',
            },
          })
        },
      },
    ])

    const result = await runCli(['action', 'triage', 'T-20002', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
      createWorkClient: workClient.createWorkClient,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      cli: { projectId: 'wrkq', forced: false },
    })
  })

  test('action triage --force uses a fresh idempotency key', async () => {
    const workClient = createFakeWorkClient({
      taskId: 'T-20003',
      projectUuid: 'project-uuid-acp',
      projectId: 'agent-control-plane',
    })
    const fetchQueue = createFetchQueue([
      {
        body: {
          actionRunId: 'act-force',
          wrkfRunId: 'wrun-force',
          externalRunRef: 'hrc:hrc-force',
          replay: false,
        },
        assert(request) {
          const body = request.body as { idempotencyKey?: string }
          expect(body.idempotencyKey).toMatch(/^task:T-20003:action:triage:force:\d+:[0-9a-f-]+$/)
          expect(body.idempotencyKey).not.toBe('task:T-20003:action:triage')
        },
      },
    ])

    const result = await runCli(['action', 'triage', 'T-20003', '--force', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
      createWorkClient: workClient.createWorkClient,
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      replay: false,
      cli: { forced: true },
    })
  })

  test('action triage text output surfaces replay and HRC binding', async () => {
    const workClient = createFakeWorkClient({
      taskId: 'T-20004',
      projectUuid: 'project-uuid-agent-spaces',
      projectId: 'agent-spaces',
    })
    const fetchQueue = createFetchQueue([
      {
        body: {
          source: 'wrkf-action',
          taskId: 'T-20004',
          actionRunId: 'act-replay',
          wrkfRunId: 'wrun-replay',
          externalRunRef: 'hrc:hrc-replay',
          replay: true,
        },
        assert(request) {
          expect(request.method).toBe('POST')
        },
      },
    ])

    const result = await runCli(['action', 'triage', 'T-20004'], {
      fetchImpl: fetchQueue.fetchImpl,
      createWorkClient: workClient.createWorkClient,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('actionRunId')
    expect(result.stdout).toContain('act-replay')
    expect(result.stdout).toContain('externalRunRef')
    expect(result.stdout).toContain('hrc:hrc-replay')
    expect(result.stdout).toContain('hrcRunId')
    expect(result.stdout).toContain('hrc-replay')
    expect(result.stdout).toContain('replay')
    expect(result.stdout).toContain('true')
  })

  test('message broadcast sends one request per repeated recipient flag', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: { messageId: 'msg-1' },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/coordination/messages')
          expect(request.body).toMatchObject({
            projectId: 'agent-spaces',
            from: { kind: 'agent', agentId: 'smokey' },
            to: { kind: 'agent', agentId: 'larry' },
            body: 'ready',
          })
        },
      },
      {
        body: { messageId: 'msg-2' },
        assert(request) {
          expect(request.body).toMatchObject({
            to: { kind: 'agent', agentId: 'cody' },
            body: 'ready',
          })
        },
      },
    ])

    const result = await runCli(
      [
        'message',
        'broadcast',
        '--project',
        'agent-spaces',
        '--from-agent',
        'smokey',
        '--to-agent',
        'larry',
        '--to-agent',
        'cody',
        '--text',
        'ready',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      results: [{ messageId: 'msg-1' }, { messageId: 'msg-2' }],
    })
    expect(fetchQueue.calls).toHaveLength(2)
  })

  test('send posts session input with subcommand-level --json', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          inputAttempt: { inputAttemptId: 'input-1' },
          run: { runId: 'run-1', status: 'queued' },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/inputs')
          expect(request.body).toMatchObject({
            sessionRef: { scopeRef: 'agent:larry:project:agent-spaces:task:primary' },
            content: 'Proceed',
          })
        },
      },
    ])

    const result = await runCli(
      ['send', '--scope-ref', 'agent:larry:project:agent-spaces', '--text', 'Proceed', '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      inputAttempt: { inputAttemptId: 'input-1' },
      run: { runId: 'run-1' },
    })
  })

  test('send can request active-run contribution intent', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          inputAttempt: { inputAttemptId: 'input-1' },
          admission: { kind: 'accepted_in_flight' },
          inputApplication: { inputApplicationId: 'iap-1', status: 'accepted' },
          currentState: { applicationStatus: 'accepted' },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/inputs')
          expect(request.body).toMatchObject({
            sessionRef: { scopeRef: 'agent:larry:project:agent-spaces:task:primary' },
            content: 'Proceed',
            intent: {
              kind: 'contribute_to_active_run',
              fallback: 'pending_only',
              contributionSemantics: 'interrupt_and_continue',
            },
          })
        },
      },
    ])

    const result = await runCli(
      [
        'send',
        '--scope-ref',
        'agent:larry:project:agent-spaces',
        '--text',
        'Proceed',
        '--intent',
        'contribute',
        '--contribution-fallback',
        'pending_only',
        '--contribution-semantics',
        'interrupt_and_continue',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      admission: { kind: 'accepted_in_flight' },
      inputApplication: { inputApplicationId: 'iap-1' },
    })
  })

  test.each([
    [
      'accepted contribution',
      {
        admission: { kind: 'accepted_in_flight' },
        inputApplication: { inputApplicationId: 'iap-accepted', status: 'accepted' },
        currentState: { applicationStatus: 'accepted' },
      },
      'Contribution accepted',
    ],
    [
      'pending contribution',
      {
        admission: { kind: 'admission_pending' },
        inputApplication: { inputApplicationId: 'iap-pending', status: 'pending' },
        currentState: { applicationStatus: 'pending' },
      },
      'Contribution pending',
    ],
    [
      'ambiguous contribution',
      {
        admission: { kind: 'admission_pending' },
        inputApplication: { inputApplicationId: 'iap-ambiguous', status: 'ambiguous' },
        currentState: { applicationStatus: 'ambiguous' },
      },
      'Contribution ambiguous',
    ],
    [
      'unsupported contribution queue fallback',
      {
        admission: { kind: 'queued_run' },
        inputApplication: { inputApplicationId: 'iap-fallback', status: 'failed' },
        currentState: {
          applicationStatus: 'failed',
          reason: 'contribution_unsupported_fallback_queued',
        },
      },
      'Unsupported contribution fallback queued',
    ],
    [
      'ordinary queued work',
      {
        admission: { kind: 'queued_run' },
        currentState: { queueStatus: 'queued' },
      },
      'Queued',
    ],
  ])('send table output labels %s without applied-only wording', async (_name, payload, label) => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          inputAttempt: { inputAttemptId: 'input-label' },
          ...payload,
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/inputs')
        },
      },
    ])

    const result = await runCli(
      ['send', '--scope-ref', 'agent:larry:project:agent-spaces', '--text', 'Proceed', '--table'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(label)
    expect(result.stdout).not.toMatch(/\bsteered\b/i)
    expect(result.stdout).not.toMatch(/\bapplied\b/i)
  })

  test('task transition parses inline evidence entries', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          task: {
            taskId: 'T-10001',
            projectId: 'agent-spaces',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'closed', outcome: 'success' },
            version: 2,
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'smokey' } },
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
          event: {
            eventId: 'wevt_1',
            taskId: 'T-10001',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            type: 'transition.applied',
            actor: { kind: 'agent', id: 'smokey' },
            observedTaskVersion: 1,
            nextTaskVersion: 2,
            idempotencyKey: 'smoke:transition',
            payload: { transitionId: 'close_success' },
            createdAt: '2026-05-09T00:00:00.000Z',
          },
          effects: [],
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/tasks/T-10001/transitions')
          expect(request.body).toMatchObject({
            transitionId: 'close_success',
            role: 'owner',
            expectedTaskVersion: 1,
            inlineEvidence: [{ kind: 'completion_note', ref: 'artifact://done' }],
            idempotencyKey: 'smoke:transition',
            actor: { agentId: 'smokey' },
          })
        },
      },
    ])

    const result = await runCli(
      [
        'task',
        'transition',
        '--task',
        'T-10001',
        '--transition',
        'close_success',
        '--actor',
        'smokey',
        '--role',
        'owner',
        '--expected-version',
        '1',
        '--evidence',
        'completion_note=artifact://done',
        '--idempotency-key',
        'smoke:transition',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: { taskId: 'T-10001', state: { status: 'closed' } },
      event: { payload: { transitionId: 'close_success' } },
    })
  })

  test('job create preserves JSON option parsing', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          job: { jobId: 'job-1', projectId: 'agent-spaces', agentId: 'larry' },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs')
          expect(request.body).toMatchObject({
            projectId: 'agent-spaces',
            agentId: 'larry',
            scopeRef: 'agent:larry:project:agent-spaces',
            schedule: { cron: '0 * * * *' },
            input: { content: 'status' },
          })
        },
      },
    ])

    const result = await runCli(
      [
        'job',
        'create',
        '--project',
        'agent-spaces',
        '--agent',
        'larry',
        '--scope-ref',
        'agent:larry:project:agent-spaces',
        '--cron',
        '0 * * * *',
        '--input',
        '{"content":"status"}',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ job: { jobId: 'job-1' } })
  })

  test('missing required send text exits with usage error contract', async () => {
    const fetchQueue = createFetchQueue([])
    const result = await runCli(
      ['send', '--scope-ref', 'agent:larry:project:agent-spaces', '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("required option '--text <text>' not specified")
    expect(fetchQueue.calls).toHaveLength(0)
  })

  test('unknown command exits with usage error contract', async () => {
    const result = await runCli(['does-not-exist'])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("unknown command 'does-not-exist'")
  })

  test('unknown subcommand under task obligation exits non-zero', async () => {
    const result = await runCli(['task', 'obligation', 'expire'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/unknown/i)
  })
})
