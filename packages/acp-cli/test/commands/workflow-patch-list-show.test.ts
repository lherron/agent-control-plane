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

const proposalSummary = {
  proposalId: 'wpp_0002',
  baseWorkflow: { id: 'basic', version: 1, hash: 'sha256:workflow' },
  patchKind: 'add_transition',
  status: 'proposed',
  createdBy: { kind: 'agent', id: 'rex' },
  createdAt: '2026-05-09T12:00:00.000Z',
  sourceAnomalyIds: ['anom_0001'],
  rationaleSummary: 'Repeated inconclusive verification should be modeled explicitly.',
}

const fullProposal = {
  ...proposalSummary,
  taskId: 'T-12345',
  patch: {
    transitionId: 'retry_verify',
    requires: [{ type: 'evidence', kinds: ['retry_plan'] }],
  },
  replayExpectations: {
    historicalCaseIds: ['case-1'],
    expectedOutcome: 'retry becomes legal',
  },
}

describe('workflow patch CLI commands', () => {
  test('list --json requests task, status, and limit filters and round-trips the response', async () => {
    const seen: string[] = []
    const result = await runCli(
      [
        '--server',
        'http://acp.test',
        'workflow',
        'patch',
        'list',
        '--task',
        'T-12345',
        '--status',
        'proposed',
        '--limit',
        '1',
        '--json',
      ],
      async (input, init) => {
        seen.push(String(input))
        expect(init?.method).toBe('GET')
        return new Response(JSON.stringify({ proposals: [proposalSummary] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    )

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual([
      'http://acp.test/v1/tasks/T-12345/workflow-patch-proposals?status=proposed&limit=1',
    ])
    expect(JSON.parse(result.stdout)).toEqual({ proposals: [proposalSummary] })
  })

  test('list human output collapses the patch payload', async () => {
    const result = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'patch', 'list', '--task', 'T-12345'],
      async () =>
        new Response(
          JSON.stringify({ proposals: [{ ...proposalSummary, patch: fullProposal.patch }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('wpp_0002')
    expect(result.stdout).toContain('add_transition')
    expect(result.stdout).not.toContain('retry_verify')
    expect(result.stdout).not.toContain('retry_plan')
  })

  test('show human output collapses patch payload while --raw prints the full record', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ proposal: fullProposal }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const human = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'patch', 'show', 'wpp_0002'],
      fetchImpl
    )
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toContain('wpp_0002')
    expect(human.stdout).not.toContain('retry_verify')

    const raw = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'patch', 'show', 'wpp_0002', '--raw'],
      fetchImpl
    )
    expect(raw.exitCode).toBe(0)
    expect(JSON.parse(raw.stdout)).toEqual({ proposal: fullProposal })
  })

  test('show --json round-trips the full proposal record', async () => {
    const seen: string[] = []
    const result = await runCli(
      ['--server', 'http://acp.test', 'workflow', 'patch', 'show', 'wpp_0002', '--json'],
      async (input, init) => {
        seen.push(String(input))
        expect(init?.method).toBe('GET')
        return new Response(JSON.stringify({ proposal: fullProposal }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    )

    expect(result.exitCode).toBe(0)
    expect(seen).toEqual(['http://acp.test/v1/workflow-patch-proposals/wpp_0002'])
    expect(JSON.parse(result.stdout)).toEqual({ proposal: fullProposal })
  })
})
