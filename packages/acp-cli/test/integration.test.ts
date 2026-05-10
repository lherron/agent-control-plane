import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openWrkqStore } from 'wrkq-lib'
import { createAcpServer } from '../../acp-server/src/index.js'
import { openCoordinationStore } from '../../coordination-substrate/src/index.js'

import { createSeededWrkqDb } from '../../wrkq-lib/test/fixtures/seed-wrkq-db.js'
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

describe('acp-cli integration', () => {
  test('manages interface bindings through admin commands', async () => {
    const seededWrkq = createSeededWrkqDb()
    const coordDir = mkdtempSync(join(tmpdir(), 'acp-cli-'))
    const coordDbPath = join(coordDir, 'coordination.db')
    const coordStore = openCoordinationStore(coordDbPath)
    const wrkqStore = openWrkqStore({
      dbPath: seededWrkq.dbPath,
      actor: { agentId: 'acp-cli-test' },
    })
    const server = createAcpServer({ wrkqStore, coordStore })

    cleanup = () => {
      wrkqStore.close()
      coordStore.close()
      seededWrkq.cleanup()
      rmSync(coordDir, { recursive: true, force: true })
    }

    const fetchImpl = async (
      input: Request | string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const request =
        input instanceof Request
          ? input
          : new Request(typeof input === 'string' ? input : input.toString(), init)
      return server.handler(request)
    }

    const setResult = await runCli(
      [
        'admin',
        'interface',
        'binding',
        'set',
        '--gateway',
        'acp-discord-smoke',
        '--conversation-ref',
        'channel:123',
        '--project',
        seededWrkq.seed.projectId,
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
        projectId: seededWrkq.seed.projectId,
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

    expect(disableResult.exitCode).toBe(0)
    expect(JSON.parse(disableResult.stdout)).toMatchObject({
      binding: {
        gatewayId: 'acp-discord-smoke',
        conversationRef: 'channel:123',
        status: 'disabled',
      },
    })
  })
})
