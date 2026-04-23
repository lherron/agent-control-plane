import { describe, expect, test } from 'bun:test'
import type { Actor } from 'acp-core'

import { type AdminStore, createInMemoryAdminStore, openSqliteAdminStore } from '../index.js'

type MembershipRole = 'coordinator' | 'implementer' | 'tester' | 'observer'

type MembershipRecord = {
  projectId: string
  agentId: string
  role: MembershipRole
  createdAt: string
  createdBy: Actor
}

type MembershipsStore = {
  add(input: {
    projectId: string
    agentId: string
    role: MembershipRole
    actor: Actor
    now: string
  }): MembershipRecord | undefined
  listByProject(projectId: string): MembershipRecord[]
}

function expectMembershipsStore(store: AdminStore): MembershipsStore {
  const memberships = (store as AdminStore & { memberships?: MembershipsStore }).memberships
  expect(memberships).toBeDefined()
  return memberships as MembershipsStore
}

const ACTOR = {
  kind: 'agent',
  id: 'smokey',
} satisfies Actor

describe('admin memberships store acceptance', () => {
  test('exports dedicated membership store helpers', async () => {
    const module = (await import('../index.js')) as Record<string, unknown>

    expect(module['createInMemoryMembershipsStore']).toBeFunction()
    expect(module['openSqliteMembershipsStore']).toBeFunction()
  })

  test('adds memberships keyed by unique projectId and agentId pairs', () => {
    const store = createInMemoryAdminStore()

    try {
      const memberships = expectMembershipsStore(store)
      const created = memberships.add({
        projectId: 'agent-spaces',
        agentId: 'smokey',
        role: 'tester',
        actor: ACTOR,
        now: '2026-04-23T03:20:00.000Z',
      })
      const repeated = memberships.add({
        projectId: 'agent-spaces',
        agentId: 'smokey',
        role: 'tester',
        actor: ACTOR,
        now: '2026-04-23T03:21:00.000Z',
      })

      expect(created).toEqual({
        projectId: 'agent-spaces',
        agentId: 'smokey',
        role: 'tester',
        createdAt: '2026-04-23T03:20:00.000Z',
        createdBy: ACTOR,
      })
      expect(repeated).toEqual(created)
      expect(memberships.listByProject('agent-spaces')).toEqual([created])
    } finally {
      store.close()
    }
  })

  test('lists memberships by project with their assigned roles', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })

    try {
      const memberships = expectMembershipsStore(store)
      memberships.add({
        projectId: 'agent-spaces',
        agentId: 'larry',
        role: 'implementer',
        actor: ACTOR,
        now: '2026-04-23T03:22:00.000Z',
      })
      memberships.add({
        projectId: 'agent-spaces',
        agentId: 'curly',
        role: 'observer',
        actor: ACTOR,
        now: '2026-04-23T03:23:00.000Z',
      })

      expect(memberships.listByProject('agent-spaces')).toEqual([
        expect.objectContaining({ agentId: 'larry', role: 'implementer' }),
        expect.objectContaining({ agentId: 'curly', role: 'observer' }),
      ])
    } finally {
      store.close()
    }
  })
})
