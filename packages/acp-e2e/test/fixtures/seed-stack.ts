import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main as runAcpCli } from 'acp-cli'
import { type AcpServer, type AcpServerDeps, createAcpServer } from 'acp-server'
import type { SessionRef } from 'agent-scope'
import { type CoordinationStore, openCoordinationStore } from 'coordination-substrate'
import { ActorResolver, type WrkqStore, openWrkqStore } from 'wrkq-lib'

import {
  type SeededWrkqFixture,
  createSeededWrkqDb,
} from '../../../wrkq-lib/test/fixtures/seed-wrkq-db.js'

type CliExitResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type RequestOptions = {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string> | undefined
}

type CliAdapter = {
  run(args: string[], env?: Record<string, string>): Promise<CliExitResult>
  request(options: RequestOptions): Promise<Response>
  requestJson<T>(options: RequestOptions): Promise<T>
}

type SeedStackOptions = {
  launchRoleScopedRun?: AcpServerDeps['launchRoleScopedRun'] | undefined
  runtimeResolver?: AcpServerDeps['runtimeResolver'] | undefined
}

export type SeedStack = {
  cli: CliAdapter
  coordStore: CoordinationStore
  seed: SeededWrkqFixture['seed']
  seededWrkq: SeededWrkqFixture
  server: AcpServer
  wrkqStore: WrkqStore
  cleanup(): void
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

  const decoder = new TextDecoder()
  if (chunk instanceof ArrayBuffer) {
    target.push(decoder.decode(new Uint8Array(chunk)))
    return
  }

  target.push(decoder.decode(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
}

function createInProcessFetch(server: AcpServer) {
  return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === 'string' ? input : input.href, init)
    return server.handler(request)
  }
}

async function runCli(
  args: string[],
  fetchImpl: ReturnType<typeof createInProcessFetch>,
  env?: Record<string, string>
): Promise<CliExitResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env ?? {})) {
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
    await runAcpCli(args, { fetchImpl })
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: 0,
    }
  } catch (error) {
    if (error instanceof CliExit) {
      return {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        exitCode: error.code,
      }
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

function ensureDemoActors(wrkqStore: WrkqStore): void {
  const actorResolver = new ActorResolver(wrkqStore.sqlite, { agentId: 'acp-e2e' })
  actorResolver.resolveActorUuid({ agentId: 'larry' })
  actorResolver.resolveActorUuid({ agentId: 'curly' })
}

function defaultRuntimeResolver(): NonNullable<AcpServerDeps['runtimeResolver']> {
  return async (sessionRef: SessionRef) => ({
    agentRoot: `/tmp/${sessionRef.scopeRef.replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    projectRoot: '/tmp/acp-e2e-project',
    cwd: '/tmp/acp-e2e-project',
    runMode: 'task',
    bundle: { kind: 'agent-default' },
    harness: { provider: 'openai', interactive: true, model: 'gpt-5-codex' },
  })
}

export function createSeedStack(options: SeedStackOptions = {}): SeedStack {
  const seededWrkq = createSeededWrkqDb()
  const coordDirectory = mkdtempSync(join(tmpdir(), 'acp-e2e-'))
  const coordDbPath = join(coordDirectory, 'coordination.db')
  const coordStore = openCoordinationStore(coordDbPath)
  const wrkqStore = openWrkqStore({
    dbPath: seededWrkq.dbPath,
    actor: { agentId: 'acp-e2e' },
  })

  ensureDemoActors(wrkqStore)

  const server = createAcpServer({
    wrkqStore,
    coordStore,
    ...(options.launchRoleScopedRun !== undefined
      ? { launchRoleScopedRun: options.launchRoleScopedRun }
      : {}),
    runtimeResolver: options.runtimeResolver ?? defaultRuntimeResolver(),
  })
  const fetchImpl = createInProcessFetch(server)

  const cli: CliAdapter = {
    run(args, env) {
      return runCli(args, fetchImpl, env)
    },
    async request(options: RequestOptions) {
      const headers = new Headers(options.headers)
      if (options.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }

      return fetchImpl(`http://acp.test${options.path}`, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
    },
    async requestJson<T>(options: RequestOptions) {
      const response = await this.request(options)
      return (await response.json()) as T
    },
  }

  return {
    cli,
    coordStore,
    seed: seededWrkq.seed,
    seededWrkq,
    server,
    wrkqStore,
    cleanup() {
      wrkqStore.close()
      coordStore.close()
      seededWrkq.cleanup()
      rmSync(coordDirectory, { recursive: true, force: true })
    },
  }
}

export async function withSeedStack<T>(
  run: (stack: SeedStack) => Promise<T> | T,
  options?: SeedStackOptions
): Promise<T> {
  const stack = createSeedStack(options)

  try {
    return await run(stack)
  } finally {
    stack.cleanup()
  }
}
