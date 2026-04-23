import { describe, expect, test } from 'bun:test'
import type { Actor } from 'acp-core'

import { type AdminStore, createInMemoryAdminStore, openSqliteAdminStore } from '../index.js'

type AdminAgentStatus = 'active' | 'disabled'

type AdminAgentRecord = {
  agentId: string
  displayName?: string | undefined
  status: AdminAgentStatus
  createdAt: string
  updatedAt: string
  createdBy: Actor
  updatedBy: Actor
}

type CreateAgentInput = {
  agentId: string
  displayName?: string | undefined
  status: AdminAgentStatus
  actor: Actor
  now: string
}

type PatchAgentInput = {
  agentId: string
  displayName?: string | undefined
  status?: AdminAgentStatus | undefined
  actor: Actor
  now: string
}

type AgentsStore = {
  create(input: CreateAgentInput): AdminAgentRecord
  list(): AdminAgentRecord[]
  get(agentId: string): AdminAgentRecord | undefined
  patch(input: PatchAgentInput): AdminAgentRecord | undefined
}

function expectAgentsStore(store: AdminStore): AgentsStore {
  const agents = (store as AdminStore & { agents?: AgentsStore }).agents
  expect(agents).toBeDefined()
  return agents as AgentsStore
}

const ACTOR = {
  kind: 'agent',
  id: 'smokey',
  displayName: 'Smokey',
} satisfies Actor

describe('admin agents store acceptance', () => {
  test('exports dedicated agent store helpers', async () => {
    const module = (await import('../index.js')) as Record<string, unknown>

    expect(module['createInMemoryAgentsStore']).toBeFunction()
    expect(module['openSqliteAgentsStore']).toBeFunction()
  })

  test('creates idempotently by agentId and lists persisted agents', () => {
    const store = createInMemoryAdminStore()

    try {
      const agents = expectAgentsStore(store)

      const created = agents.create({
        agentId: 'smokey',
        displayName: 'Smokey',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T02:30:00.000Z',
      })
      const repeated = agents.create({
        agentId: 'smokey',
        displayName: 'Smokey',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T02:31:00.000Z',
      })

      expect(created).toEqual({
        agentId: 'smokey',
        displayName: 'Smokey',
        status: 'active',
        createdAt: '2026-04-23T02:30:00.000Z',
        updatedAt: '2026-04-23T02:30:00.000Z',
        createdBy: ACTOR,
        updatedBy: ACTOR,
      })
      expect(repeated).toEqual(created)
      expect(agents.list()).toEqual([created])
    } finally {
      store.close()
    }
  })

  test('gets by id and patches display name and status with actor stamping', () => {
    const store = createInMemoryAdminStore()

    try {
      const agents = expectAgentsStore(store)
      agents.create({
        agentId: 'larry',
        displayName: 'Larry',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T02:40:00.000Z',
      })

      const patched = agents.patch({
        agentId: 'larry',
        displayName: 'Larry 2',
        status: 'disabled',
        actor: { kind: 'human', id: 'operator', displayName: 'Operator' },
        now: '2026-04-23T02:45:00.000Z',
      })

      expect(agents.get('larry')).toEqual(patched)
      expect(patched).toEqual({
        agentId: 'larry',
        displayName: 'Larry 2',
        status: 'disabled',
        createdAt: '2026-04-23T02:40:00.000Z',
        updatedAt: '2026-04-23T02:45:00.000Z',
        createdBy: ACTOR,
        updatedBy: { kind: 'human', id: 'operator', displayName: 'Operator' },
      })
    } finally {
      store.close()
    }
  })

  test('supports the sqlite-backed helper with the same uniqueness guarantees', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })

    try {
      const agents = expectAgentsStore(store)
      agents.create({
        agentId: 'curly',
        status: 'active',
        actor: ACTOR,
        now: '2026-04-23T02:50:00.000Z',
      })

      expect(agents.list()).toEqual([
        expect.objectContaining({
          agentId: 'curly',
          status: 'active',
        }),
      ])
      expect(agents.get('missing')).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
