import { describe, expect, test } from 'bun:test'

import { withInterfaceStore } from './helpers.js'

describe('MessageSourceRepo', () => {
  test('recordIfNew is idempotent on gatewayId and messageRef', () => {
    withInterfaceStore(({ store }) => {
      const first = store.messageSources.recordIfNew({
        gatewayId: 'discord_prod',
        messageRef: 'discord:message:12345',
        bindingId: 'bind-1',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
        authorRef: 'discord:user:42',
        receivedAt: '2026-04-20T15:30:00.000Z',
      })

      const second = store.messageSources.recordIfNew({
        gatewayId: 'discord_prod',
        messageRef: 'discord:message:12345',
        bindingId: 'bind-2',
        conversationRef: 'channel:999',
        authorRef: 'discord:user:999',
        receivedAt: '2026-04-20T15:31:00.000Z',
      })

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.record).toEqual(first.record)
      expect(store.messageSources.getByMessageRef('discord_prod', 'discord:message:12345')).toEqual(
        first.record
      )
    })
  })
})
