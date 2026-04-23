import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from '../index.js'

describe('GAP 4: heartbeat target persistence', () => {
  test('upsert with scopeRef persists target and defaults laneRef to main', () => {
    const store = createInMemoryAdminStore()
    try {
      const heartbeat = store.heartbeats.upsert({
        agentId: 'curly',
        scopeRef: 'agent:curly:project:agent-spaces',
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(heartbeat.targetScopeRef).toBe('agent:curly:project:agent-spaces')
      expect(heartbeat.targetLaneRef).toBe('main')
    } finally {
      store.close()
    }
  })

  test('upsert with scopeRef and explicit laneRef persists both', () => {
    const store = createInMemoryAdminStore()
    try {
      const heartbeat = store.heartbeats.upsert({
        agentId: 'curly',
        scopeRef: 'agent:curly:project:agent-spaces',
        laneRef: 'lane:repair',
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(heartbeat.targetScopeRef).toBe('agent:curly:project:agent-spaces')
      expect(heartbeat.targetLaneRef).toBe('lane:repair')
    } finally {
      store.close()
    }
  })

  test('upsert without scopeRef does not persist target fields', () => {
    const store = createInMemoryAdminStore()
    try {
      const heartbeat = store.heartbeats.upsert({
        agentId: 'larry',
        source: 'cli',
        now: '2026-04-23T10:00:00.000Z',
      })

      expect(heartbeat.targetScopeRef).toBeUndefined()
      expect(heartbeat.targetLaneRef).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('subsequent upsert without target preserves existing target', () => {
    const store = createInMemoryAdminStore()
    try {
      // First upsert with target
      store.heartbeats.upsert({
        agentId: 'curly',
        scopeRef: 'agent:curly:project:agent-spaces',
        now: '2026-04-23T10:00:00.000Z',
      })

      // Second upsert without target
      const heartbeat = store.heartbeats.upsert({
        agentId: 'curly',
        source: 'scheduler',
        now: '2026-04-23T10:05:00.000Z',
      })

      // Target should be preserved
      expect(heartbeat.targetScopeRef).toBe('agent:curly:project:agent-spaces')
      expect(heartbeat.targetLaneRef).toBe('main')
      // But heartbeat timestamp should be updated
      expect(heartbeat.lastHeartbeatAt).toBe('2026-04-23T10:05:00.000Z')
      expect(heartbeat.source).toBe('scheduler')
    } finally {
      store.close()
    }
  })

  test('upsert with new scopeRef overrides existing target', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'curly',
        scopeRef: 'agent:curly:project:old-project',
        now: '2026-04-23T10:00:00.000Z',
      })

      const heartbeat = store.heartbeats.upsert({
        agentId: 'curly',
        scopeRef: 'agent:curly:project:new-project',
        laneRef: 'lane:alt',
        now: '2026-04-23T10:05:00.000Z',
      })

      expect(heartbeat.targetScopeRef).toBe('agent:curly:project:new-project')
      expect(heartbeat.targetLaneRef).toBe('lane:alt')
    } finally {
      store.close()
    }
  })

  test('get returns target fields from persisted heartbeat', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'smokey',
        scopeRef: 'agent:smokey:project:wrkq',
        laneRef: 'main',
        source: 'test',
        now: '2026-04-23T10:00:00.000Z',
      })

      const heartbeat = store.heartbeats.get('smokey')
      expect(heartbeat?.targetScopeRef).toBe('agent:smokey:project:wrkq')
      expect(heartbeat?.targetLaneRef).toBe('main')
      expect(heartbeat?.source).toBe('test')
    } finally {
      store.close()
    }
  })

  test('list returns target fields for all heartbeats', () => {
    const store = createInMemoryAdminStore()
    try {
      store.heartbeats.upsert({
        agentId: 'with-target',
        scopeRef: 'agent:with-target:project:p1',
        now: '2026-04-23T10:00:00.000Z',
      })
      store.heartbeats.upsert({
        agentId: 'without-target',
        now: '2026-04-23T10:01:00.000Z',
      })

      const all = store.heartbeats.list()
      const withTarget = all.find((h) => h.agentId === 'with-target')
      const withoutTarget = all.find((h) => h.agentId === 'without-target')

      expect(withTarget?.targetScopeRef).toBe('agent:with-target:project:p1')
      expect(withTarget?.targetLaneRef).toBe('main')
      expect(withoutTarget?.targetScopeRef).toBeUndefined()
      expect(withoutTarget?.targetLaneRef).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
