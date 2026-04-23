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

      await fixture.request({
        method: 'POST',
        path: '/v1/admin/interface-identities',
        body: {
          gatewayId: 'slack_prod',
          externalId: 'U123',
          displayName: 'Slack Smokey',
        },
      })

      const listResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/interface-identities?gateway=discord_prod',
      })

      expect(listResponse.status).toBe(200)
      expect(
        await fixture.json<{
          interfaceIdentities: Array<{ gatewayId: string; externalId: string; linkedAgentId?: string | undefined }>
        }>(listResponse)
      ).toEqual({
        interfaceIdentities: [
          expect.objectContaining({
            gatewayId: 'discord_prod',
            externalId: 'user:123',
            linkedAgentId: 'smokey',
          }),
        ],
      })

      const filteredResponse = await fixture.request({
        method: 'GET',
        path: '/v1/admin/interface-identities?gateway=discord_prod&externalId=user%3A123',
      })

      expect(filteredResponse.status).toBe(200)
      expect(
        await fixture.json<{
          interfaceIdentities: Array<{ gatewayId: string; externalId: string }>
        }>(filteredResponse)
      ).toEqual({
        interfaceIdentities: [
          expect.objectContaining({ gatewayId: 'discord_prod', externalId: 'user:123' }),
        ],
      })
    })
  })

  test('returns 400 when GET filters are blank strings', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/admin/interface-identities?gateway=',
      })

      expect(response.status).toBe(400)
      expect(await fixture.json<{ error: { code: string; details?: { field?: string } } }>(response)).toEqual({
        error: expect.objectContaining({
          code: 'malformed_request',
          details: expect.objectContaining({ field: 'gateway' }),
        }),
      })
    })
  })
})
