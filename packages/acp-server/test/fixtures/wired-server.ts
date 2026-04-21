import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'

import { type CoordinationStore, openCoordinationStore } from 'coordination-substrate'
import { type WrkqStore, openWrkqStore } from 'wrkq-lib'

import {
  type SeededWrkqFixture,
  createSeededWrkqDb,
} from '../../../wrkq-lib/test/fixtures/seed-wrkq-db.js'
import {
  type AcpServerDeps,
  InMemoryInputAttemptStore,
  InMemoryRunStore,
  createAcpServer,
} from '../../src/index.js'

type RequestOptions = {
  method: string
  path: string
  body?: unknown
  headers?: HeadersInit | undefined
}

export type WiredServerFixture = {
  handler(request: Request): Promise<Response>
  request(options: RequestOptions): Promise<Response>
  json<T>(response: Response): Promise<T>
  wrkqStore: WrkqStore
  coordStore: CoordinationStore
  interfaceStore: InterfaceStore
  runStore: InMemoryRunStore
  inputAttemptStore: InMemoryInputAttemptStore
  seed: SeededWrkqFixture['seed']
}

export async function withWiredServer<T>(
  run: (fixture: WiredServerFixture) => Promise<T> | T,
  overrides: Partial<Omit<AcpServerDeps, 'wrkqStore' | 'coordStore'>> = {}
): Promise<T> {
  const seededWrkq = createSeededWrkqDb()
  const coordDirectory = mkdtempSync(join(tmpdir(), 'acp-server-'))
  const coordDbPath = join(coordDirectory, 'coordination.db')
  const interfaceDbPath = join(coordDirectory, 'acp-interface.db')
  const coordStore = openCoordinationStore(coordDbPath)
  const interfaceStore = openInterfaceStore({ dbPath: interfaceDbPath })
  const wrkqStore = openWrkqStore({
    dbPath: seededWrkq.dbPath,
    actor: { agentId: 'acp-server' },
  })
  const runStore = new InMemoryRunStore()
  const inputAttemptStore = new InMemoryInputAttemptStore()
  const server = createAcpServer({
    wrkqStore,
    coordStore,
    interfaceStore,
    runStore,
    inputAttemptStore,
    ...overrides,
  })

  const fixture: WiredServerFixture = {
    handler: server.handler,
    async request(options: RequestOptions): Promise<Response> {
      const headers = new Headers(options.headers)
      if (options.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }

      return server.handler(
        new Request(`http://acp.test${options.path}`, {
          method: options.method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        })
      )
    },
    async json<T>(response: Response): Promise<T> {
      return (await response.json()) as T
    },
    wrkqStore,
    coordStore,
    interfaceStore,
    runStore,
    inputAttemptStore,
    seed: seededWrkq.seed,
  }

  try {
    return await run(fixture)
  } finally {
    wrkqStore.close()
    coordStore.close()
    interfaceStore.close()
    rmSync(coordDirectory, { recursive: true, force: true })
    seededWrkq.cleanup()
  }
}
