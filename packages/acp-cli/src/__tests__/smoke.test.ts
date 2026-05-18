import { describe, expect, test } from 'bun:test'

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
    expect(result.stdout).toContain('message')
  })

  test('task create produces structured JSON and captures repeatable roles', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          task: {
            taskId: 'T-10001',
            projectId: 'agent-spaces',
            workflow: { id: 'basic', version: 1, hash: 'sha256:test' },
            state: { status: 'open', phase: 'todo' },
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'larry' } },
            version: 0,
            createdAt: '2026-05-09T00:00:00.000Z',
            updatedAt: '2026-05-09T00:00:00.000Z',
          },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/tasks')
          expect(request.headers.get('x-acp-actor-agent-id')).toBe('smokey')
          expect(request.body).toMatchObject({
            projectId: 'agent-spaces',
            workflow: { id: 'basic', version: 1 },
            goal: 'demo',
            roleBindings: { owner: { kind: 'agent', id: 'larry' } },
            idempotencyKey: 'smoke:create',
            actor: { agentId: 'smokey' },
          })
        },
      },
    ])

    const result = await runCli(
      [
        'task',
        'create',
        '--workflow',
        'basic@1',
        '--project',
        'agent-spaces',
        '--goal',
        'demo',
        '--actor',
        'smokey',
        '--role',
        'owner:larry',
        '--idempotency-key',
        'smoke:create',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ task: { taskId: expect.any(String) } })
    expect(fetchQueue.calls).toHaveLength(1)
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

  test('workflow ref validation rejects invalid versions before side effects', async () => {
    const fetchQueue = createFetchQueue([])
    const result = await runCli(
      [
        'task',
        'create',
        '--workflow',
        'basic@0',
        '--project',
        'agent-spaces',
        '--goal',
        'demo',
        '--actor',
        'smokey',
        '--role',
        'owner:larry',
        '--idempotency-key',
        'smoke:create',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--workflow must be an integer >= 1')
    expect(fetchQueue.calls).toHaveLength(0)
  })
})
