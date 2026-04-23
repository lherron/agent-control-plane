import { describe, expect, test } from 'bun:test'

import { type AdminStore, createInMemoryAdminStore, openSqliteAdminStore } from '../index.js'

type SystemEventRecord = {
  eventId: string
  projectId: string
  kind: string
  payload: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

type SystemEventsStore = {
  append(input: {
    projectId: string
    kind: string
    payload: Record<string, unknown>
    occurredAt: string
    recordedAt: string
  }): SystemEventRecord
  list(filters?: {
    projectId?: string | undefined
    kind?: string | undefined
    occurredAfter?: string | undefined
    occurredBefore?: string | undefined
  }): SystemEventRecord[]
}

function expectSystemEventsStore(store: AdminStore): SystemEventsStore {
  const systemEvents = (store as AdminStore & { systemEvents?: SystemEventsStore }).systemEvents
  expect(systemEvents).toBeDefined()
  return systemEvents as SystemEventsStore
}

describe('admin system events store acceptance', () => {
  test('exports dedicated system event store helpers', async () => {
    const module = (await import('../index.js')) as Record<string, unknown>

    expect(module['createInMemorySystemEventsStore']).toBeFunction()
    expect(module['openSqliteSystemEventsStore']).toBeFunction()
  })

  test('appends immutable events and lists them with filters', () => {
    const store = createInMemoryAdminStore()

    try {
      const systemEvents = expectSystemEventsStore(store)
      const first = systemEvents.append({
        projectId: 'agent-spaces',
        kind: 'project.created',
        payload: { source: 'acceptance-test' },
        occurredAt: '2026-04-23T03:40:00.000Z',
        recordedAt: '2026-04-23T03:40:01.000Z',
      })
      const second = systemEvents.append({
        projectId: 'agent-spaces',
        kind: 'membership.added',
        payload: { agentId: 'smokey', role: 'tester' },
        occurredAt: '2026-04-23T03:41:00.000Z',
        recordedAt: '2026-04-23T03:41:01.000Z',
      })

      expect(first).toEqual({
        eventId: '1',
        projectId: 'agent-spaces',
        kind: 'project.created',
        payload: { source: 'acceptance-test' },
        occurredAt: '2026-04-23T03:40:00.000Z',
        recordedAt: '2026-04-23T03:40:01.000Z',
      })
      expect(systemEvents.list({ projectId: 'agent-spaces' })).toEqual([first, second])
      expect(systemEvents.list({ kind: 'membership.added' })).toEqual([second])
      expect(
        systemEvents.list({
          occurredAfter: '2026-04-23T03:40:30.000Z',
          occurredBefore: '2026-04-23T03:41:30.000Z',
        })
      ).toEqual([second])
    } finally {
      store.close()
    }
  })

  test('supports the sqlite-backed helper for append-only listing', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })

    try {
      const systemEvents = expectSystemEventsStore(store)
      systemEvents.append({
        projectId: 'wrkq',
        kind: 'default-agent.updated',
        payload: { agentId: 'smokey' },
        occurredAt: '2026-04-23T03:42:00.000Z',
        recordedAt: '2026-04-23T03:42:01.000Z',
      })

      expect(systemEvents.list({ projectId: 'wrkq' })).toEqual([
        expect.objectContaining({
          projectId: 'wrkq',
          kind: 'default-agent.updated',
        }),
      ])
    } finally {
      store.close()
    }
  })
})
