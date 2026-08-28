import { describe, expect, test } from 'bun:test'
import { openInterfaceStore } from '../open-store.js'

describe('Discord ledger projection store', () => {
  test('persists monotone cursors and replaces a room route with the latest binding', () => {
    const store = openInterfaceStore({ dbPath: ':memory:' })
    expect(store.discordLedgerProjection.getCursor('discord')).toBeUndefined()
    expect(store.discordLedgerProjection.advanceCursor('discord', 12)).toBe(12)
    expect(store.discordLedgerProjection.advanceCursor('discord', 9)).toBe(12)

    store.discordLedgerProjection.recordRoute({
      gatewayId: 'discord',
      roomUuid: 'room-1',
      roomKey: 'T-00001',
      bindingId: 'binding-old',
      conversationRef: 'channel:1',
      humanPrincipalRef: 'agent:lance',
    })
    store.discordLedgerProjection.recordRoute({
      gatewayId: 'discord',
      roomUuid: 'room-1',
      roomKey: 'T-00001',
      bindingId: 'binding-new',
      conversationRef: 'channel:1',
      threadRef: 'thread:2',
      humanPrincipalRef: 'agent:lance',
    })

    expect(store.discordLedgerProjection.getRoute('discord', 'room-1')).toEqual(
      expect.objectContaining({ bindingId: 'binding-new', threadRef: 'thread:2' })
    )
    expect(store.discordLedgerProjection.pruneBindings('discord', ['binding-new'])).toBe(0)
    expect(store.discordLedgerProjection.pruneBindings('discord', [])).toBe(1)
    expect(store.discordLedgerProjection.getRoute('discord', 'room-1')).toBeUndefined()
    store.close()
  })
})
