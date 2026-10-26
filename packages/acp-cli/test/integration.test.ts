import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createInMemoryWrkqStoreAdapter } from '../../acp-core/test/fixtures/wrkq-store-adapter.js'
import { createAcpServer } from '../../acp-server/src/index.js'
import { openCoordinationStore } from '../../coordination-substrate/src/index.js'

import { main } from '../src/cli.js'

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

let cleanup: (() => void) | undefined

beforeEach(() => {
  cleanup = undefined
})

afterEach(() => {
  cleanup?.()
})

async function runCli(
  args: string[],
  options: {
    fetchImpl: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
    env?: Record<string, string> | undefined
  }
): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(options.env ?? {})) {
    originalEnv.set(key, process.env[key])
    process.env[key] = value
  }

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
    await main(args, { fetchImpl: options.fetchImpl })
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
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

type WiredServer = {
  fetchImpl: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
  requests: Request[]
}

function createWiredServer(): WiredServer {
  const coordDir = mkdtempSync(join(tmpdir(), 'acp-cli-'))
  const coordDbPath = join(coordDir, 'coordination.db')
  const coordStore = openCoordinationStore(coordDbPath)
  const wrkqStore = createInMemoryWrkqStoreAdapter()

  // The interface store is DECLARED, not inherited. `createAcpServer` with no
  // `interfaceStore` used to fall back to the operator's production
  // acp-interface.db, and this test wrote its fixture bindings straight into
  // it — green on the operator's Mac for exactly that reason, EACCES anywhere
  // else (T-06914 finding D). That fallback now throws under a test runner, so
  // naming a temp DB here is the contract rather than tidiness.
  const previousInterfaceDbPath = process.env['ACP_INTERFACE_DB_PATH']
  process.env['ACP_INTERFACE_DB_PATH'] = join(coordDir, 'interface.db')
  const server = createAcpServer({ wrkqStore, coordStore })

  cleanup = () => {
    if (previousInterfaceDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')
    } else {
      process.env['ACP_INTERFACE_DB_PATH'] = previousInterfaceDbPath
    }
    coordStore.close()
    rmSync(coordDir, { recursive: true, force: true })
  }

  const requests: Request[] = []
  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.toString(), init)
    requests.push(request.clone())
    return server.handler(request)
  }

  return { fetchImpl, requests }
}

describe('acp-cli integration', () => {
  test('manages interface bindings through admin commands', async () => {
    const { fetchImpl } = createWiredServer()

    const setResult = await runCli(
      [
        'admin',
        'interface',
        'binding',
        'set',
        '--gateway',
        'acp-discord-smoke',
        '--gateway-type',
        'discord',
        '--conversation-ref',
        'channel:123',
        '--session',
        'cody@agent-spaces:discord',
        '--json',
      ],
      { fetchImpl }
    )

    expect(setResult.exitCode).toBe(0)
    expect(JSON.parse(setResult.stdout)).toMatchObject({
      binding: {
        gatewayId: 'acp-discord-smoke',
        conversationRef: 'channel:123',
        sessionRef: {
          scopeRef: 'agent:cody:project:agent-spaces:task:discord',
          laneRef: 'main',
        },
        projectId: 'agent-spaces',
        status: 'active',
      },
    })

    const listResult = await runCli(
      [
        'admin',
        'interface',
        'binding',
        'list',
        '--gateway',
        'acp-discord-smoke',
        '--conversation-ref',
        'channel:123',
        '--json',
      ],
      { fetchImpl }
    )

    expect(listResult.exitCode).toBe(0)
    expect(JSON.parse(listResult.stdout)).toMatchObject({
      bindings: [
        {
          gatewayId: 'acp-discord-smoke',
          conversationRef: 'channel:123',
          sessionRef: {
            scopeRef: 'agent:cody:project:agent-spaces:task:discord',
            laneRef: 'main',
          },
        },
      ],
    })

    const disableResult = await runCli(
      [
        'admin',
        'interface',
        'binding',
        'disable',
        '--gateway',
        'acp-discord-smoke',
        '--conversation-ref',
        'channel:123',
        '--json',
      ],
      { fetchImpl }
    )

    // Disable flips status only: gatewayType and every other field survive (T-11922).
    expect(disableResult.exitCode).toBe(0)
    const disabled = JSON.parse(disableResult.stdout) as { binding: Record<string, unknown> }
    const listed = JSON.parse(listResult.stdout) as { bindings: Array<Record<string, unknown>> }
    expect(disabled.binding).toEqual({
      ...listed.bindings[0],
      status: 'disabled',
      updatedAt: disabled.binding['updatedAt'],
    })
    expect(disabled.binding['gatewayType']).toBe('discord')
  })

  test('job validate exits non-zero on an invalid job and still prints the errors', async () => {
    const { fetchImpl } = createWiredServer()
    const dir = mkdtempSync(join(tmpdir(), 'acp-cli-job-'))
    const jobFile = join(dir, 'job.json')
    writeFileSync(jobFile, JSON.stringify({ schedule: { cron: 'not a cron' } }))
    try {
      const jsonResult = await runCli(['job', 'validate', '--in', jobFile, '--json'], {
        fetchImpl,
      })
      expect(jsonResult.exitCode).toBe(1)
      expect(JSON.parse(jsonResult.stdout)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expect.objectContaining({ code: 'invalid_cron' })]),
      })

      const tableResult = await runCli(['job', 'validate', '--in', jobFile], { fetchImpl })
      expect(tableResult.exitCode).toBe(1)
      expect(tableResult.stdout).toContain('invalid_cron')

      const goodFile = join(dir, 'good.json')
      writeFileSync(
        goodFile,
        JSON.stringify({
          schedule: { cron: '0 3 * * *' },
          flow: { sequence: [{ id: 'step-1', input: 'noop' }] },
        })
      )
      const goodResult = await runCli(['job', 'validate', '--in', goodFile, '--json'], {
        fetchImpl,
      })
      expect(goodResult.exitCode).toBe(0)
      expect(JSON.parse(goodResult.stdout)).toEqual({ valid: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('job create rejects --job because the server mints job ids', async () => {
    const { fetchImpl, requests } = createWiredServer()

    const result = await runCli(
      [
        'job',
        'create',
        '--job',
        'my-job',
        '--project',
        'agent-spaces',
        '--agent',
        'cody',
        '--scope-ref',
        'agent:cody:project:agent-spaces',
        '--cron',
        '0 3 * * *',
        '--input',
        '{"content":"noop"}',
        '--disabled',
      ],
      { fetchImpl }
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--job')
    expect(requests).toHaveLength(0)
  })

  test('governance commands accept --actor and send it as the actor header', async () => {
    const { fetchImpl, requests } = createWiredServer()
    const actorArgs = ['--actor', 'verify-scratch', '--json']
    const commands = [
      ['project', 'create', '--project', 'agent-spaces', '--display-name', 'Agent Spaces'],
      ['agent', 'create', '--agent', 'cody', '--status', 'active'],
      ['project', 'list'],
      ['project', 'show', '--project', 'agent-spaces'],
      ['agent', 'list'],
      ['agent', 'show', '--agent', 'cody'],
      ['membership', 'list', '--project', 'agent-spaces'],
      ['heartbeat', 'set', '--agent', 'cody', '--source', 'test'],
      [
        'interface',
        'identity',
        'register',
        '--gateway',
        'acp-discord-smoke',
        '--external-id',
        'user:1',
        '--linked-agent',
        'cody',
      ],
      [
        'system-event',
        'push',
        '--project',
        'agent-spaces',
        '--kind',
        'verify.scratch',
        '--payload',
        '{"task":"T-11922"}',
        '--occurred-at',
        '2026-10-26T00:00:00.000Z',
      ],
      ['system-event', 'list', '--project', 'agent-spaces'],
    ]

    for (const command of commands) {
      const result = await runCli([...command, ...actorArgs], { fetchImpl })
      expect({ command: command.slice(0, 2).join(' '), stderr: result.stderr }).toEqual({
        command: command.slice(0, 2).join(' '),
        stderr: '',
      })
      expect(result.exitCode).toBe(0)
      expect(requests.at(-1)?.headers.get('x-acp-actor-agent-id')).toBe('verify-scratch')
    }

    // wake with no target is a server-side 400, which proves --actor parsed.
    const wake = await runCli(['heartbeat', 'wake', '--agent', 'cody', ...actorArgs], {
      fetchImpl,
    })
    expect(wake.stderr).not.toContain('unknown flag')
    expect(requests.at(-1)?.headers.get('x-acp-actor-agent-id')).toBe('verify-scratch')
  })
})
