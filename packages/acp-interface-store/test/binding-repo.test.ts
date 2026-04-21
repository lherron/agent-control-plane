import { describe, expect, test } from 'bun:test'

import { withInterfaceStore } from './helpers.js'

describe('BindingRepo', () => {
  test('resolve prefers exact thread match, falls back, and skips disabled bindings', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-channel',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        scopeRef: 'scope:project',
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
        scopeRef: 'scope:project',
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
        scopeRef: 'scope:project',
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
        scopeRef: 'scope:a',
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
        scopeRef: 'scope:b',
        laneRef: 'ops',
        projectId: 'P-2',
        status: 'active',
        createdAt: '2026-04-20T15:05:00.000Z',
        updatedAt: '2026-04-20T15:05:00.000Z',
      })

      expect(store.bindings.list({ gatewayId: 'discord_prod', projectId: 'P-2' })).toEqual([
        expect.objectContaining({ bindingId: 'bind-2' }),
      ])
      expect(
        store.bindings.list({
          gatewayId: 'discord_prod',
          conversationRef: 'channel:999',
          threadRef: 'thread:9',
        })
      ).toEqual([expect.objectContaining({ bindingId: 'bind-2' })])
    })
  })
})
