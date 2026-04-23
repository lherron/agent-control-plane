import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('admin interface identity endpoints', () => {
  test('creates and upserts interface identities', async () => {
    await withWiredServer(async (fixture) => {
      const created = await fixture.request({
        method: 'POST',
        path: '/v1/admin/interface-identities',
        body: {
          gatewayId: 'discord_prod',
          externalId: 'user:123',
          displayName: 'Smokey Bot',
        },
      })

      expect(created.status).toBe(201)
      expect(
        await fixture.json<{ interfaceIdentity: { gatewayId: string; externalId: string } }>(
          created
        )
      ).toEqual({
        interfaceIdentity: expect.objectContaining({
          gatewayId: 'discord_prod',
          externalId: 'user:123',
        }),
      })

      const upserted = await fixture.request({
        method: 'POST',
        path: '/v1/admin/interface-identities',
        body: {
          gatewayId: 'discord_prod',
          externalId: 'user:123',
          displayName: 'Smokey Bot',
          linkedAgentId: 'smokey',
        },
      })

      expect(upserted.status).toBe(200)
      expect(
        await fixture.json<{ interfaceIdentity: { linkedAgentId?: string | undefined } }>(upserted)
      ).toEqual({
        interfaceIdentity: expect.objectContaining({ linkedAgentId: 'smokey' }),
      })
    })
  })
})
