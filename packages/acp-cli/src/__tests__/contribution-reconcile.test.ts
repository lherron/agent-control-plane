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

describe('acp admin contributions reconcile', () => {
  test('--json output shape is stable for a single input application', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          results: [
            {
              inputApplicationId: 'iap_red_json',
              inputAttemptId: 'iat_red_json',
              previousStatus: 'pending',
              status: 'accepted',
              hrcStatus: 'duplicate',
            },
          ],
          summary: { accepted: 1, failed: 0, pending: 0 },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/contributions/reconcile')
          expect(request.headers.get('x-acp-actor-agent-id')).toBe('smokey')
          expect(request.body).toEqual({ inputApplicationId: 'iap_red_json' })
        },
      },
    ])

    const result = await runCli(
      [
        'admin',
        'contributions',
        'reconcile',
        '--input-application-id',
        'iap_red_json',
        '--actor',
        'smokey',
        '--json',
      ],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      results: [
        {
          inputApplicationId: 'iap_red_json',
          inputAttemptId: 'iat_red_json',
          previousStatus: 'pending',
          status: 'accepted',
          hrcStatus: 'duplicate',
        },
      ],
      summary: { accepted: 1, failed: 0, pending: 0 },
    })
    expect(fetchQueue.calls).toHaveLength(1)
  })

  test('--all-pending posts allPending true and preserves JSON summary fields', async () => {
    const fetchQueue = createFetchQueue([
      {
        body: {
          results: [
            {
              inputApplicationId: 'iap_still_pending',
              inputAttemptId: 'iat_still_pending',
              previousStatus: 'pending',
              status: 'pending',
              hrcStatus: 'pending',
            },
          ],
          summary: { accepted: 0, failed: 0, pending: 1 },
        },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/admin/contributions/reconcile')
          expect(request.body).toEqual({ allPending: true })
        },
      },
    ])

    const result = await runCli(
      ['admin', 'contributions', 'reconcile', '--all-pending', '--json'],
      { fetchImpl: fetchQueue.fetchImpl }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      results: [
        {
          inputApplicationId: 'iap_still_pending',
          status: 'pending',
          hrcStatus: 'pending',
        },
      ],
      summary: { accepted: 0, failed: 0, pending: 1 },
    })
    expect(fetchQueue.calls).toHaveLength(1)
  })
})
