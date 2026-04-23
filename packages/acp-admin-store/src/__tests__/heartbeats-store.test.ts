import { describe, expect, test } from 'bun:test'

import { STALE_HEARTBEAT_EVENT_KIND, checkStaleHeartbeats } from '../heartbeat-stale.js'
import {
  STALE_HEARTBEAT_THRESHOLD_MS,
  createInMemoryAdminStore,
  openSqliteAdminStore,
} from '../index.js'

describe('heartbeats store', () => {
  test('upsert creates a heartbeat and get reads it back', () => {
    const store = createInMemoryAdminStore()
    try {
      store.agents.create({
        agentId: 'smokey',
        status: 'active',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T04:00:00.000Z',
      })

      const heartbeat = store.heartbeats.upsert({
        agentId: 'smokey',
        source: 'cli',
        note: 'alive and well',
        now: '2026-04-23T04:01:00.000Z',
      })

      expect(heartbeat).toEqual({
        agentId: 'smokey',
        lastHeartbeatAt: '2026-04-23T04:01:00.000Z',
        source: 'cli',
        lastNote: 'alive and well',
        status: 'alive',
      })

      const retrieved = store.heartbeats.get('smokey')
      expect(retrieved).toEqual(heartbeat)
    } finally {
      store.close()
    }
  })

  test('upsert updates existing heartbeat timestamp and metadata', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'clod',
        source: 'scheduler',
        now: '2026-04-23T04:00:00.000Z',
      })

      const updated = store.heartbeats.upsert({
        agentId: 'clod',
        source: 'manual',
        note: 'checked in',
        now: '2026-04-23T04:10:00.000Z',
      })

      expect(updated.lastHeartbeatAt).toBe('2026-04-23T04:10:00.000Z')
      expect(updated.source).toBe('manual')
      expect(updated.lastNote).toBe('checked in')
      expect(updated.status).toBe('alive')
    } finally {
      store.close()
    }
  })

  test('get returns undefined for unknown agent', () => {
    const store = createInMemoryAdminStore()
    try {
      expect(store.heartbeats.get('nonexistent')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('list returns heartbeats ordered by most recent first', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'alpha',
        now: '2026-04-23T04:00:00.000Z',
      })
      store.heartbeats.upsert({
        agentId: 'beta',
        now: '2026-04-23T04:05:00.000Z',
      })
      store.heartbeats.upsert({
        agentId: 'gamma',
        now: '2026-04-23T04:02:00.000Z',
      })

      const all = store.heartbeats.list()
      expect(all.map((h) => h.agentId)).toEqual(['beta', 'gamma', 'alpha'])
    } finally {
      store.close()
    }
  })

  test('listStale returns agents older than the given threshold', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'fresh',
        now: '2026-04-23T04:09:00.000Z',
      })
      store.heartbeats.upsert({
        agentId: 'stale',
        now: '2026-04-23T03:50:00.000Z',
      })

      // Threshold is 10 minutes before "now"
      const thresholdIso = '2026-04-23T04:00:00.000Z'
      const staleAgents = store.heartbeats.listStale(thresholdIso)
      expect(staleAgents).toHaveLength(1)
      expect(staleAgents[0]!.agentId).toBe('stale')
    } finally {
      store.close()
    }
  })

  test('optional fields omitted when null', () => {
    const store = createInMemoryAdminStore()
    try {
      const heartbeat = store.heartbeats.upsert({
        agentId: 'minimal',
        now: '2026-04-23T04:00:00.000Z',
      })

      expect(heartbeat.source).toBeUndefined()
      expect(heartbeat.lastNote).toBeUndefined()
      expect(heartbeat.agentId).toBe('minimal')
      expect(heartbeat.status).toBe('alive')
    } finally {
      store.close()
    }
  })

  test('sqlite-backed store supports heartbeats', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })
    try {
      const heartbeat = store.heartbeats.upsert({
        agentId: 'persisted',
        source: 'test',
        now: '2026-04-23T04:00:00.000Z',
      })

      expect(heartbeat.agentId).toBe('persisted')
      expect(store.heartbeats.get('persisted')).toEqual(heartbeat)
    } finally {
      store.close()
    }
  })
})

describe('stale heartbeat detection', () => {
  test('STALE_HEARTBEAT_THRESHOLD_MS defaults to 10 minutes', () => {
    expect(STALE_HEARTBEAT_THRESHOLD_MS).toBe(600_000)
  })

  test('checkStaleHeartbeats emits system events for stale agents', () => {
    const store = createInMemoryAdminStore()
    try {
      // Set up a project + membership so system events can be emitted
      store.projects.create({
        projectId: 'test-project',
        displayName: 'Test Project',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })
      store.agents.create({
        agentId: 'stale-agent',
        status: 'active',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })
      store.memberships.add({
        projectId: 'test-project',
        agentId: 'stale-agent',
        role: 'implementer',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })

      // Agent's last heartbeat was 15 minutes ago
      store.heartbeats.upsert({
        agentId: 'stale-agent',
        source: 'test',
        now: '2026-04-23T03:45:00.000Z',
      })

      // Check at T+15min with 10min threshold
      const now = new Date('2026-04-23T04:00:00.000Z')
      const result = checkStaleHeartbeats(store, { now })

      expect(result.staleAgents).toHaveLength(1)
      expect(result.staleAgents[0]!.agentId).toBe('stale-agent')
      expect(result.eventsEmitted).toBe(1)

      // Verify the system event was emitted
      const events = store.systemEvents.list({ kind: STALE_HEARTBEAT_EVENT_KIND })
      expect(events).toHaveLength(1)
      expect(events[0]!.projectId).toBe('test-project')
      expect(events[0]!.kind).toBe('agent.heartbeat.stale')
      expect((events[0]!.payload as Record<string, unknown>)['agentId']).toBe('stale-agent')
      expect((events[0]!.payload as Record<string, unknown>)['thresholdMs']).toBe(600_000)
    } finally {
      store.close()
    }
  })

  test('checkStaleHeartbeats skips agents without project membership', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'orphan-agent',
        now: '2026-04-23T03:45:00.000Z',
      })

      const now = new Date('2026-04-23T04:00:00.000Z')
      const result = checkStaleHeartbeats(store, { now })

      expect(result.staleAgents).toHaveLength(1)
      expect(result.eventsEmitted).toBe(0) // No project found
    } finally {
      store.close()
    }
  })

  test('checkStaleHeartbeats does not flag fresh agents', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'fresh-agent',
        now: '2026-04-23T03:55:00.000Z',
      })

      const now = new Date('2026-04-23T04:00:00.000Z')
      const result = checkStaleHeartbeats(store, { now })

      expect(result.staleAgents).toHaveLength(0)
      expect(result.eventsEmitted).toBe(0)
    } finally {
      store.close()
    }
  })

  test('checkStaleHeartbeats uses custom threshold', () => {
    const store = createInMemoryAdminStore()
    try {
      store.projects.create({
        projectId: 'test-project',
        displayName: 'Test Project',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })
      store.agents.create({
        agentId: 'agent-1',
        status: 'active',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })
      store.memberships.add({
        projectId: 'test-project',
        agentId: 'agent-1',
        role: 'implementer',
        actor: { kind: 'agent', id: 'operator' },
        now: '2026-04-23T03:00:00.000Z',
      })

      // Last heartbeat was 3 minutes ago
      store.heartbeats.upsert({
        agentId: 'agent-1',
        now: '2026-04-23T03:57:00.000Z',
      })

      // Custom 2-minute threshold → should flag as stale
      const now = new Date('2026-04-23T04:00:00.000Z')
      const result = checkStaleHeartbeats(store, { now, thresholdMs: 2 * 60 * 1000 })

      expect(result.staleAgents).toHaveLength(1)
      expect(result.eventsEmitted).toBe(1)
    } finally {
      store.close()
    }
  })
})
