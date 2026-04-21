import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('interface binding endpoints', () => {
  test('creates, replaces, and lists bindings', async () => {
    await withWiredServer(async (fixture) => {
      const createResponse = await fixture.request({
        method: 'POST',
        path: '/v1/interface/bindings',
        body: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          projectId: fixture.seed.projectId,
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
        },
      })
      const createdPayload = await fixture.json<{
        binding: {
          bindingId: string
          gatewayId: string
          conversationRef: string
          projectId?: string
          sessionRef: { scopeRef: string; laneRef: string }
          status: string
        }
      }>(createResponse)

      expect(createResponse.status).toBe(201)
      expect(createdPayload.binding.gatewayId).toBe('discord_prod')
      expect(createdPayload.binding.projectId).toBe(fixture.seed.projectId)
      expect(createdPayload.binding.sessionRef).toEqual({
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
      })
      expect(createdPayload.binding.status).toBe('active')

      const replaceResponse = await fixture.request({
        method: 'POST',
        path: '/v1/interface/bindings',
        body: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          projectId: fixture.seed.projectId,
          status: 'disabled',
          sessionRef: {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
            laneRef: 'lane:repair',
          },
        },
      })
      const replacedPayload = await fixture.json<{
        binding: {
          bindingId: string
          sessionRef: { scopeRef: string; laneRef: string }
          status: string
        }
      }>(replaceResponse)

      expect(replaceResponse.status).toBe(200)
      expect(replacedPayload.binding.bindingId).toBe(createdPayload.binding.bindingId)
      expect(replacedPayload.binding.sessionRef).toEqual({
        scopeRef: `agent:larry:project:${fixture.seed.projectId}`,
        laneRef: 'lane:repair',
      })
      expect(replacedPayload.binding.status).toBe('disabled')

      const listResponse = await fixture.request({
        method: 'GET',
        path: `/v1/interface/bindings?gatewayId=discord_prod&projectId=${fixture.seed.projectId}`,
      })
      const listPayload = await fixture.json<{
        bindings: Array<{
          bindingId: string
          sessionRef: { scopeRef: string; laneRef: string }
          status: string
        }>
      }>(listResponse)

      expect(listResponse.status).toBe(200)
      expect(listPayload.bindings).toHaveLength(1)
      expect(listPayload.bindings[0]).toEqual(replacedPayload.binding)
    })
  })

  test('rejects malformed create bodies', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/interface/bindings',
        body: {
          conversationRef: 'channel:123',
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('malformed_request')
    })
  })

  test('rejects blank list filters', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/interface/bindings?gatewayId=',
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('malformed_request')
    })
  })
})
