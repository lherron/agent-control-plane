import { main } from '../src/cli.js'

export type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
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

  target.push(Buffer.from(chunk as ArrayBufferView).toString('utf8'))
}

export async function runCli(
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

export type FetchExpectation = {
  status?: number | undefined
  body?: unknown
  text?: string | undefined
  assert(request: {
    url: string
    method: string
    headers: Headers
    body: unknown
  }): void | Promise<void>
}

export function createFetchQueue(expectations: FetchExpectation[]) {
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

      await expectation.assert(recorded)
      return new Response(
        expectation.text ??
          (expectation.body === undefined ? null : JSON.stringify(expectation.body)),
        {
          status: expectation.status ?? 200,
          headers: {
            'content-type':
              expectation.text !== undefined ? 'application/x-ndjson' : 'application/json',
          },
        }
      )
    },
  }
}
