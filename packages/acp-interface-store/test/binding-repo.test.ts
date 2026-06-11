import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from '../src/index.js'
import Database from '../src/sqlite.js'
import { withInterfaceStore } from './helpers.js'

describe('BindingRepo', () => {
  test('resolve prefers exact thread match, falls back, and skips disabled bindings', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-channel',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        scopeRef: 'agent:test-agent:project:P-00003',
        laneRef: 'main',
        projectId: 'P-00003',
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      store.bindings.create({
        bindingId: 'bind-thread',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
        scopeRef: 'agent:test-agent:project:P-00003',
        laneRef: 'repair',
        projectId: 'P-00003',
        status: 'active',
        createdAt: '2026-04-20T15:01:00.000Z',
        updatedAt: '2026-04-20T15:01:00.000Z',
      })

      const exact = store.bindings.resolve({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
      })

      expect(exact?.bindingId).toBe('bind-thread')
      expect(exact?.laneRef).toBe('repair')

      const replaced = store.bindings.upsertByLookup({
        bindingId: 'bind-thread-new',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
        scopeRef: 'agent:test-agent:project:P-00003',
        laneRef: 'repair',
        projectId: 'P-00003',
        status: 'disabled',
        createdAt: '2026-04-20T16:00:00.000Z',
        updatedAt: '2026-04-20T16:00:00.000Z',
      })

      expect(replaced.bindingId).toBe('bind-thread')
      expect(replaced.status).toBe('disabled')
      expect(replaced.updatedAt).toBe('2026-04-20T16:00:00.000Z')

      const fallback = store.bindings.resolve({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
      })

      expect(fallback?.bindingId).toBe('bind-channel')
      expect(fallback?.laneRef).toBe('main')
    })
  })

  test('lists bindings with filters', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-1',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        scopeRef: 'agent:a-agent:project:P-1',
        laneRef: 'main',
        projectId: 'P-1',
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })
      store.bindings.create({
        bindingId: 'bind-2',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:999',
        threadRef: 'thread:9',
        scopeRef: 'agent:b-agent:project:P-2',
        laneRef: 'ops',
        projectId: 'P-2',
        status: 'active',
        createdAt: '2026-04-20T15:05:00.000Z',
        updatedAt: '2026-04-20T15:05:00.000Z',
      })

      expect(store.bindings.list({ gatewayId: 'discord_prod', projectId: 'P-2' })).toEqual([
        expect.objectContaining({ bindingId: 'bind-2' }),
      ])
      expect(store.bindings.list({ gatewayType: 'unknown' })).toHaveLength(2)
      expect(
        store.bindings.list({
          gatewayId: 'discord_prod',
          conversationRef: 'channel:999',
          threadRef: 'thread:9',
        })
      ).toEqual([expect.objectContaining({ bindingId: 'bind-2' })])
    })
  })

  test('resolves active project-level primary candidates by gateway type', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-primary',
        gatewayId: 'acp-discord-smoke',
        gatewayType: 'discord',
        conversationRef: 'channel:primary',
        scopeRef: 'agent:mneme:project:media-ingest',
        laneRef: 'main',
        projectId: 'media-ingest',
        status: 'active',
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
      })
      store.bindings.create({
        bindingId: 'bind-task',
        gatewayId: 'acp-discord-smoke',
        gatewayType: 'discord',
        conversationRef: 'channel:task',
        scopeRef: 'agent:mneme:project:media-ingest:task:T-1',
        laneRef: 'main',
        projectId: 'media-ingest',
        status: 'active',
        createdAt: '2026-06-10T00:01:00.000Z',
        updatedAt: '2026-06-10T00:01:00.000Z',
      })

      expect(
        store.bindings.listPrimaryCandidates({
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
          laneRef: 'main',
        })
      ).toEqual([expect.objectContaining({ bindingId: 'bind-primary' })])
    })
  })

  test('legacy migration preserves and backfills gateway_type through constraint tightening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'acp-interface-store-legacy-'))
    const dbPath = join(directory, 'interface.sqlite')
    const sqlite = new Database(dbPath)
    try {
      sqlite.exec(`
        CREATE TABLE interface_bindings (
          binding_id TEXT PRIMARY KEY,
          gateway_id TEXT NOT NULL,
          conversation_ref TEXT NOT NULL,
          thread_ref TEXT,
          scope_ref TEXT NOT NULL,
          lane_ref TEXT NOT NULL,
          project_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO interface_bindings (
          binding_id, gateway_id, conversation_ref, thread_ref, scope_ref, lane_ref,
          project_id, status, created_at, updated_at
        ) VALUES (
          'ifb_legacy_smoke', 'acp-discord-smoke', 'channel:mneme', NULL,
          'agent:mneme:project:media-ingest', 'main', 'media-ingest', 'active',
          '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z'
        );
      `)
      sqlite.close()

      const store = openInterfaceStore({ dbPath })
      try {
        const binding = store.bindings.getById('ifb_legacy_smoke')
        expect(binding).toMatchObject({
          bindingId: 'ifb_legacy_smoke',
          gatewayType: 'discord',
          agentId: 'mneme',
          projectId: 'media-ingest',
        })
      } finally {
        store.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects bindings without a project segment in scopeRef', () => {
    withInterfaceStore(({ store }) => {
      expect(() =>
        store.bindings.create({
          bindingId: 'bind-bad',
          gatewayId: 'g',
          conversationRef: 'c:1',
          scopeRef: 'agent:foo',
          laneRef: 'main',
          projectId: 'foo',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        })
      ).toThrow(/project segment/)
    })
  })

  test('rejects bindings missing projectId field', () => {
    withInterfaceStore(({ store }) => {
      expect(() =>
        store.bindings.create({
          bindingId: 'bind-bad',
          gatewayId: 'g',
          conversationRef: 'c:1',
          scopeRef: 'agent:foo:project:bar',
          laneRef: 'main',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        })
      ).toThrow(/projectId is required/)
    })
  })

  test('rejects bindings whose projectId disagrees with scopeRef', () => {
    withInterfaceStore(({ store }) => {
      expect(() =>
        store.bindings.create({
          bindingId: 'bind-bad',
          gatewayId: 'g',
          conversationRef: 'c:1',
          scopeRef: 'agent:foo:project:bar',
          laneRef: 'main',
          projectId: 'baz',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        })
      ).toThrow(/disagrees/)
    })
  })

  test('persists structured agentId/taskId/roleName derived from scopeRef', () => {
    withInterfaceStore(({ store }) => {
      const saved = store.bindings.create({
        bindingId: 'bind-task-role',
        gatewayId: 'g',
        conversationRef: 'c:1',
        scopeRef: 'agent:cody:project:agent-spaces:task:T-99:role:reviewer',
        laneRef: 'main',
        projectId: 'agent-spaces',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      })

      expect(saved.agentId).toBe('cody')
      expect(saved.projectId).toBe('agent-spaces')
      expect(saved.taskId).toBe('T-99')
      expect(saved.roleName).toBe('reviewer')

      const reread = store.bindings.getById('bind-task-role')
      expect(reread?.agentId).toBe('cody')
      expect(reread?.taskId).toBe('T-99')
      expect(reread?.roleName).toBe('reviewer')
    })
  })

  test('project-scoped binding has no taskId or roleName', () => {
    withInterfaceStore(({ store }) => {
      const saved = store.bindings.create({
        bindingId: 'bind-proj-only',
        gatewayId: 'g',
        conversationRef: 'c:2',
        scopeRef: 'agent:foo:project:bar',
        laneRef: 'main',
        projectId: 'bar',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      })

      expect(saved.agentId).toBe('foo')
      expect(saved.projectId).toBe('bar')
      expect(saved.taskId).toBeUndefined()
      expect(saved.roleName).toBeUndefined()
    })
  })
})
