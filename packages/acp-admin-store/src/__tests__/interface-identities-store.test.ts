import { describe, expect, test } from 'bun:test'

import { type AdminStore, createInMemoryAdminStore, openSqliteAdminStore } from '../index.js'

type InterfaceIdentityRecord = {
  gatewayId: string
  externalId: string
  displayName?: string | undefined
  linkedAgentId?: string | undefined
  createdAt: string
  updatedAt: string
}

type InterfaceIdentitiesStore = {
  register(input: {
    gatewayId: string
    externalId: string
    displayName?: string | undefined
    linkedAgentId?: string | undefined
    now: string
  }): InterfaceIdentityRecord
  getByCompositeKey(input: { gatewayId: string; externalId: string }):
    | InterfaceIdentityRecord
    | undefined
}

function expectInterfaceIdentitiesStore(store: AdminStore): InterfaceIdentitiesStore {
  const interfaceIdentities = (
    store as AdminStore & {
      interfaceIdentities?: InterfaceIdentitiesStore
    }
  ).interfaceIdentities
  expect(interfaceIdentities).toBeDefined()
  return interfaceIdentities as InterfaceIdentitiesStore
}

describe('admin interface identities store acceptance', () => {
  test('exports dedicated interface identity store helpers', async () => {
    const module = (await import('../index.js')) as Record<string, unknown>

    expect(module['createInMemoryInterfaceIdentitiesStore']).toBeFunction()
    expect(module['openSqliteInterfaceIdentitiesStore']).toBeFunction()
  })

  test('registers and upserts interface identities by composite key', () => {
    const store = createInMemoryAdminStore()

    try {
      const identities = expectInterfaceIdentitiesStore(store)
      const created = identities.register({
        gatewayId: 'discord_prod',
        externalId: 'user:123',
        displayName: 'Smokey Bot',
        now: '2026-04-23T03:30:00.000Z',
      })
      const upserted = identities.register({
        gatewayId: 'discord_prod',
        externalId: 'user:123',
        displayName: 'Smokey Bot',
        linkedAgentId: 'smokey',
        now: '2026-04-23T03:31:00.000Z',
      })

      expect(created).toEqual({
        gatewayId: 'discord_prod',
        externalId: 'user:123',
        displayName: 'Smokey Bot',
        createdAt: '2026-04-23T03:30:00.000Z',
        updatedAt: '2026-04-23T03:30:00.000Z',
      })
      expect(upserted).toEqual({
        gatewayId: 'discord_prod',
        externalId: 'user:123',
        displayName: 'Smokey Bot',
        linkedAgentId: 'smokey',
        createdAt: '2026-04-23T03:30:00.000Z',
        updatedAt: '2026-04-23T03:31:00.000Z',
      })
      expect(
        identities.getByCompositeKey({
          gatewayId: 'discord_prod',
          externalId: 'user:123',
        })
      ).toEqual(upserted)
    } finally {
      store.close()
    }
  })

  test('supports the sqlite-backed helper for composite-key lookup', () => {
    const store = openSqliteAdminStore({ dbPath: ':memory:' })

    try {
      const identities = expectInterfaceIdentitiesStore(store)
      identities.register({
        gatewayId: 'slack_prod',
        externalId: 'U123',
        linkedAgentId: 'larry',
        now: '2026-04-23T03:32:00.000Z',
      })

      expect(
        identities.getByCompositeKey({
          gatewayId: 'slack_prod',
          externalId: 'U123',
        })
      ).toEqual(
        expect.objectContaining({
          gatewayId: 'slack_prod',
          externalId: 'U123',
          linkedAgentId: 'larry',
        })
      )
    } finally {
      store.close()
    }
  })
})
