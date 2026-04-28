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

describe('job-run wait', () => {
  test('polls until terminal status (running → succeeded)', async () => {
    const fetchQueue = createFetchQueue([
      {
        // First GET: running
        body: {
          jobRun: { jobRunId: 'jr-1', jobId: 'job-1', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-1')
        },
      },
      {
        // Second GET (poll): still running
        body: {
          jobRun: { jobRunId: 'jr-1', jobId: 'job-1', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-1')
        },
      },
      {
        // Third GET (poll): succeeded
        body: {
          jobRun: { jobRunId: 'jr-1', jobId: 'job-1', status: 'succeeded' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-1')
        },
      },
    ])

    const result = await runCli(
      [
        'job-run',
        'wait',
        '--job-run',
        'jr-1',
        '--poll-interval',
        '10',
        '--timeout',
        '5000',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      jobRun: { jobRunId: 'jr-1', status: 'succeeded' },
    })
    expect(output.timedOut).toBeUndefined()
    expect(fetchQueue.calls).toHaveLength(3)
  })

  test('timeout is enforced', async () => {
    const fetchQueue = createFetchQueue([
      {
        // Initial GET: running
        body: {
          jobRun: { jobRunId: 'jr-2', jobId: 'job-2', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
        },
      },
      {
        // Poll: still running (enough to exhaust timeout)
        body: {
          jobRun: { jobRunId: 'jr-2', jobId: 'job-2', status: 'running' },
        },
        assert() {},
      },
    ])

    const result = await runCli(
      ['job-run', 'wait', '--job-run', 'jr-2', '--poll-interval', '10', '--timeout', '1', '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.timedOut).toBe(true)
    expect(output.jobRun.status).toBe('running')
  })

  test('already terminal returns immediately', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: { jobRunId: 'jr-3', jobId: 'job-3', status: 'failed' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
        },
      },
    ])

    const result = await runCli(
      [
        'job-run',
        'wait',
        '--job-run',
        'jr-3',
        '--poll-interval',
        '10',
        '--timeout',
        '5000',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.jobRun.status).toBe('failed')
    expect(output.timedOut).toBeUndefined()
    // Only the initial GET, no polling needed
    expect(fetchQueue.calls).toHaveLength(1)
  })
})

describe('job-run show --steps', () => {
  test('renders steps table', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: {
            jobRunId: 'jr-10',
            jobId: 'job-10',
            status: 'succeeded',
            steps: [
              { stepId: 's1', phase: 'dispatch', status: 'completed', runId: 'run-a', error: '' },
              {
                stepId: 's2',
                phase: 'verify',
                status: 'failed',
                runId: 'run-b',
                error: 'timeout',
              },
            ],
          },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-10')
        },
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-10', '--steps', '--table'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    // Table output should contain step IDs and columns
    expect(result.stdout).toContain('StepId')
    expect(result.stdout).toContain('Phase')
    expect(result.stdout).toContain('Status')
    expect(result.stdout).toContain('RunId')
    expect(result.stdout).toContain('Error')
    expect(result.stdout).toContain('s1')
    expect(result.stdout).toContain('s2')
    expect(result.stdout).toContain('dispatch')
    expect(result.stdout).toContain('verify')
    expect(result.stdout).toContain('timeout')
  })

  test('--steps with --json preserves full payload', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: {
            jobRunId: 'jr-11',
            status: 'succeeded',
            steps: [{ stepId: 's1', phase: 'dispatch', status: 'completed', runId: 'run-a' }],
          },
        },
        assert() {},
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-11', '--steps', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    // --json should return the full response, not the table
    expect(output).toMatchObject({
      jobRun: {
        jobRunId: 'jr-11',
        steps: [{ stepId: 's1' }],
      },
    })
  })

  test('empty steps renders empty table', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: {
            jobRunId: 'jr-12',
            status: 'queued',
            steps: [],
          },
        },
        assert() {},
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-12', '--steps', '--table'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    // Header should still appear
    expect(result.stdout).toContain('StepId')
  })
})

describe('job-run show --results', () => {
  test('renders results table', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: {
            jobRunId: 'jr-20',
            status: 'succeeded',
            steps: [
              { stepId: 's1', result: { outcome: 'ok', data: 42 } },
              { stepId: 's2', result: null },
              { stepId: 's3', result: 'plain-string' },
            ],
          },
        },
        assert(request) {
          expect(request.method).toBe('GET')
        },
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-20', '--results', '--table'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('StepId')
    expect(result.stdout).toContain('Result')
    expect(result.stdout).toContain('s1')
    expect(result.stdout).toContain('s2')
    expect(result.stdout).toContain('s3')
    // JSON result rendered
    expect(result.stdout).toContain('"outcome":"ok"')
    // String result rendered
    expect(result.stdout).toContain('plain-string')
  })

  test('--results with --json preserves full payload', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: {
            jobRunId: 'jr-21',
            status: 'succeeded',
            steps: [{ stepId: 's1', result: { answer: 42 } }],
          },
        },
        assert() {},
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-21', '--results', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.jobRun.steps[0].result).toEqual({ answer: 42 })
  })
})

describe('existing job-run list/show unchanged', () => {
  test('job-run list without new flags works as before', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRuns: [{ jobRunId: 'jr-30', jobId: 'job-30', status: 'running', runId: 'run-30' }],
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/jobs/job-30/runs')
        },
      },
    ])

    const result = await runCli(['job-run', 'list', '--job', 'job-30', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      jobRuns: [{ jobRunId: 'jr-30', status: 'running' }],
    })
  })

  test('job-run show without --steps/--results works as before', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: { jobRunId: 'jr-31', jobId: 'job-31', status: 'succeeded' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-31')
        },
      },
    ])

    const result = await runCli(['job-run', 'show', '--job-run', 'jr-31', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      jobRun: { jobRunId: 'jr-31', status: 'succeeded' },
    })
  })
})

describe('job run --wait', () => {
  test('polls until terminal after triggering job run', async () => {
    const fetchQueue = createFetchQueue([
      {
        // POST /v1/admin/jobs/job-40/run -> returns running job run
        body: {
          jobRun: { jobRunId: 'jr-40', jobId: 'job-40', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs/job-40/run')
        },
      },
      {
        // Initial GET for pollJobRun
        body: {
          jobRun: { jobRunId: 'jr-40', jobId: 'job-40', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/job-runs/jr-40')
        },
      },
      {
        // Poll GET: succeeded
        body: {
          jobRun: { jobRunId: 'jr-40', jobId: 'job-40', status: 'succeeded' },
        },
        assert(request) {
          expect(request.method).toBe('GET')
        },
      },
    ])

    const result = await runCli(
      [
        'job',
        'run',
        '--job',
        'job-40',
        '--wait',
        '--poll-interval',
        '10',
        '--timeout',
        '5000',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      jobRun: { jobRunId: 'jr-40', status: 'succeeded' },
    })
    expect(output.timedOut).toBeUndefined()
  })

  test('job run without --wait returns immediately', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          jobRun: { jobRunId: 'jr-41', jobId: 'job-41', status: 'running' },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/jobs/job-41/run')
        },
      },
    ])

    const result = await runCli(['job', 'run', '--job', 'job-41', '--json'], {
      fetchImpl: fetchQueue.fetchImpl,
    })

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      jobRun: { jobRunId: 'jr-41', status: 'running' },
    })
    // Only the initial POST, no polling
    expect(fetchQueue.calls).toHaveLength(1)
  })
})
