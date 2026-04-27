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
            kind: 'task',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            lifecycleState: 'open',
            phase: 'open',
            riskClass: 'medium',
            roleMap: { implementer: 'larry', tester: 'cody' },
            version: 0,
          },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/tasks')
          expect(request.headers.get('x-acp-actor-agent-id')).toBe('smokey')
          expect(request.body).toMatchObject({
            projectId: 'agent-spaces',
            workflowPreset: 'code_defect_fastlane',
            presetVersion: 1,
            riskClass: 'medium',
            roleMap: { implementer: 'larry', tester: 'cody' },
            actor: { agentId: 'smokey' },
          })
        },
      },
    ])

    const result = await runCli(
      [
        'task',
        'create',
        '--preset',
        'code_defect_fastlane',
        '--preset-version',
        '1',
        '--risk-class',
        'medium',
        '--project',
        'agent-spaces',
        '--actor',
        'smokey',
        '--role',
        'implementer:larry',
        '--role',
        'tester:cody',
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
            sessionRef: { scopeRef: 'agent:larry:project:agent-spaces' },
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

  test('task transition parses comma-list evidence refs', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          task: { taskId: 'T-10001', phase: 'green', version: 1 },
          transition: { to: { phase: 'green' } },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/tasks/T-10001/transitions')
          expect(request.body).toMatchObject({
            toPhase: 'green',
            expectedVersion: 0,
            evidenceRefs: ['artifact://red', 'artifact://green'],
            actor: { agentId: 'smokey', role: 'tester' },
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
        '--to',
        'green',
        '--actor',
        'smokey',
        '--actor-role',
        'tester',
        '--expected-version',
        '0',
        '--evidence',
        'artifact://red, artifact://green',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      task: { taskId: 'T-10001', phase: 'green' },
      transition: { to: { phase: 'green' } },
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

  test('integer validation rejects invalid preset versions before side effects', async () => {
    const fetchQueue = createFetchQueue([])
    const result = await runCli(
      [
        'task',
        'create',
        '--preset',
        'code_defect_fastlane',
        '--preset-version',
        '0',
        '--risk-class',
        'medium',
        '--project',
        'agent-spaces',
        '--actor',
        'smokey',
        '--role',
        'implementer:larry',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--preset-version must be an integer >= 1')
    expect(fetchQueue.calls).toHaveLength(0)
  })
})
