import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('gateway delivery endpoints', () => {
  test('streams queued deliveries in stable order and honors cursors', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_002',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        runId: 'run_b',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'second',
        createdAt: '2026-04-20T15:00:00.000Z',
      })
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_001',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        runId: 'run_a',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'first',
        createdAt: '2026-04-20T15:00:00.000Z',
      })
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_003',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        runId: 'run_b',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'third',
        createdAt: '2026-04-20T15:00:00.000Z',
      })

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/gateway/discord_prod/deliveries/stream',
      })
      const payload = await fixture.json<{
        deliveries: Array<{ deliveryRequestId: string; body: { text: string } }>
        nextCursor: string
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.deliveries.map((delivery) => delivery.deliveryRequestId)).toEqual([
        'dr_001',
        'dr_002',
        'dr_003',
      ])
      expect(payload.deliveries.map((delivery) => delivery.body.text)).toEqual([
        'first',
        'second',
        'third',
      ])
      expect(payload.nextCursor).toBe('2026-04-20T15:00:00.000Z|run_b|dr_003')

      const emptyResponse = await fixture.request({
        method: 'GET',
        path: `/v1/gateway/discord_prod/deliveries/stream?since=${encodeURIComponent(payload.nextCursor)}`,
      })
      const emptyPayload = await fixture.json<{
        deliveries: Array<{ deliveryRequestId: string }>
        nextCursor: string
      }>(emptyResponse)

      expect(emptyResponse.status).toBe(200)
      expect(emptyPayload.deliveries).toEqual([])
      expect(emptyPayload.nextCursor).toBe(payload.nextCursor)
    })
  })

  test('rejects invalid delivery cursors', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: '/v1/gateway/discord_prod/deliveries/stream?since=not-a-cursor',
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('malformed_request')
    })
  })

  test('acks queued deliveries', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_ack',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'ack me',
        createdAt: '2026-04-20T15:00:00.000Z',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_ack/ack',
      })
      const payload = await fixture.json<{
        delivery: { status: string; deliveredAt?: string }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.delivery.status).toBe('delivered')
      expect(payload.delivery.deliveredAt).toEqual(expect.any(String))
    })
  })

  test('rejects ack for terminal deliveries', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_done',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'done',
        createdAt: '2026-04-20T15:00:00.000Z',
      })
      fixture.interfaceStore.deliveries.ack('dr_done', '2026-04-20T15:01:00.000Z')

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_done/ack',
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(422)
      expect(payload.error.code).toBe('delivery_not_ackable')
    })
  })

  test('fails queued deliveries with a code and message', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_fail',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'fail me',
        createdAt: '2026-04-20T15:00:00.000Z',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_fail/fail',
        body: {
          code: 'discord_http_error',
          message: 'transport rejected the message',
        },
      })
      const payload = await fixture.json<{
        delivery: { status: string; failure?: { code: string; message: string } }
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.delivery.status).toBe('failed')
      expect(payload.delivery.failure).toEqual({
        code: 'discord_http_error',
        message: 'transport rejected the message',
      })
    })
  })

  test('rejects malformed fail requests', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_fail_bad',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'bad fail',
        createdAt: '2026-04-20T15:00:00.000Z',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_fail_bad/fail',
        body: {
          code: '',
          message: 'transport rejected the message',
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(400)
      expect(payload.error.code).toBe('malformed_request')
    })
  })
})
