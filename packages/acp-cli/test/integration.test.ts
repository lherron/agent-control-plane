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
  test('runs all five task commands against an in-process server handler', async () => {
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

    const createResult = await runCli(
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
        seededWrkq.seed.projectId,
        '--actor',
        'tracy',
        '--role',
        'implementer:larry',
        '--role',
        'tester:curly',
        '--json',
      ],
      { fetchImpl }
    )

    expect(createResult.exitCode).toBe(0)
    const created = JSON.parse(createResult.stdout) as { task: { taskId: string } }
    const taskId = created.task.taskId

    const showResult = await runCli(
      ['task', 'show', '--task', taskId, '--role', 'implementer', '--json'],
      { fetchImpl }
    )
    expect(showResult.exitCode).toBe(0)
    expect(JSON.parse(showResult.stdout)).toMatchObject({
      task: { taskId },
      context: { phase: 'red', requiredEvidenceKinds: ['tdd_green_bundle'] },
    })

    const evidenceResult = await runCli(
      [
        'task',
        'evidence',
        'add',
        '--task',
        taskId,
        '--kind',
        'tdd_green_bundle',
        '--ref',
        'artifact://green/1',
        '--actor',
        'larry',
        '--producer-role',
        'implementer',
        '--json',
      ],
      { fetchImpl }
    )
    expect(evidenceResult.exitCode).toBe(0)
    expect(evidenceResult.stdout.trim()).toBe('null')

    const transitionResult = await runCli(
      [
        'task',
        'transition',
        '--task',
        taskId,
        '--to',
        'green',
        '--actor',
        'larry',
        '--actor-role',
        'implementer',
        '--expected-version',
        '0',
        '--json',
      ],
      { fetchImpl }
    )
    expect(transitionResult.exitCode).toBe(0)
    expect(JSON.parse(transitionResult.stdout)).toMatchObject({
      task: { taskId, phase: 'green', version: 1 },
      transition: { to: { phase: 'green' } },
    })

    const transitionsResult = await runCli(['task', 'transitions', '--task', taskId, '--json'], {
      fetchImpl,
    })
    expect(transitionsResult.exitCode).toBe(0)
    expect(JSON.parse(transitionsResult.stdout)).toMatchObject({
      transitions: [
        {
          taskId,
          to: { phase: 'green' },
        },
      ],
    })
  })

  test('promotes a bare wrkq task through the in-process server handler', async () => {
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

    wrkqStore.taskRepo.createTask({
      taskId: 'T-70001',
      projectId: seededWrkq.seed.projectId,
      kind: 'bug',
      lifecycleState: 'open',
      phase: '',
      roleMap: {},
      version: 0,
    })

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

    const promoteResult = await runCli(
      [
        'task',
        'promote',
        '--task',
        'T-70001',
        '--preset',
        'code_defect_fastlane',
        '--preset-version',
        '1',
        '--risk-class',
        'medium',
        '--actor',
        'tracy',
        '--role',
        'implementer:larry',
        '--role',
        'tester:curly',
        '--json',
      ],
      { fetchImpl }
    )

    expect(promoteResult.exitCode).toBe(0)
    expect(JSON.parse(promoteResult.stdout)).toMatchObject({
      task: {
        taskId: 'T-70001',
        workflowPreset: 'code_defect_fastlane',
        phase: 'red',
        version: 1,
      },
      transition: {
        from: { phase: null },
        to: { phase: 'red' },
      },
    })
  })

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
