import { describe, expect, test } from 'bun:test'

import { main } from '../../src/cli.js'

type CliResult = {
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

  const view = chunk as ArrayBufferView
  target.push(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8'))
}

async function runCli(
  args: string[],
  fetchImpl: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
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
    await main(args, { fetchImpl })
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

describe('acp task evidence add', () => {
  test('posts standalone evidence provenance and prints the returned evidence id', async () => {
    const seen: Array<{
      url: string
      method?: string | undefined
      headers: Headers
      body: unknown
    }> = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        '--actor',
        'cody',
        'task',
        'evidence',
        'add',
        '--task',
        'T-12345',
        '--kind',
        'completion_note',
        '--ref',
        'artifact://done',
        '--role',
        'owner',
        '--run-id',
        'run-owner-1',
        '--idempotency-key',
        'cli:evidence:add',
        '--json',
      ],
      async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        })
        return new Response(
          JSON.stringify({
            evidence: [
              {
                evidenceId: 'evd_cli_1',
                taskId: 'T-12345',
                kind: 'completion_note',
                ref: 'artifact://done',
                actor: { kind: 'agent', id: 'cody' },
                role: 'owner',
                runId: 'run-owner-1',
              },
            ],
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      }
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      evidence: [{ evidenceId: 'evd_cli_1' }],
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://acp.test/v1/tasks/T-12345/evidence')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers.get('x-acp-actor-agent-id')).toBe('cody')
    expect(seen[0]?.body).toEqual({
      actor: { kind: 'agent', id: 'cody' },
      role: 'owner',
      runId: 'run-owner-1',
      evidence: [{ kind: 'completion_note', ref: 'artifact://done' }],
      idempotencyKey: 'cli:evidence:add',
    })
  })
})
