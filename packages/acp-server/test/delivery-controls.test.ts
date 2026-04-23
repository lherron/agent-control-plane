import { describe, expect, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('delivery controls', () => {
  test('lists failed deliveries for a gateway with failure details', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_failed_visible',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:visible',
        bodyKind: 'text/markdown',
        bodyText: 'visible',
        createdAt: '2026-04-23T01:00:00.000Z',
      })
      fixture.interfaceStore.deliveries.fail({
        deliveryRequestId: 'dr_failed_visible',
        failureCode: 'gateway_timeout',
        failureMessage: 'discord timed out',
      })

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_queued_hidden',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:hidden',
        bodyKind: 'text/markdown',
        bodyText: 'hidden',
        createdAt: '2026-04-23T01:05:00.000Z',
      })

      const response = await fixture.request({
        method: 'GET',
        path: '/v1/gateway/deliveries?status=failed&gatewayId=discord_prod',
      })
      const payload = await fixture.json<{
        deliveries: Array<{
          deliveryRequestId: string
          failure: { code: string; message: string }
        }>
        nextCursor: string | null
      }>(response)

      expect(response.status).toBe(200)
      expect(payload.deliveries).toEqual([
        {
          deliveryRequestId: 'dr_failed_visible',
          failure: {
            code: 'gateway_timeout',
            message: 'discord timed out',
          },
        },
      ])
      expect(payload.nextCursor).toBeNull()
    })
  })

  test('requeues a failed delivery into a new linked delivery request', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_failed_requeue',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        runId: 'run-1',
        inputAttemptId: 'attempt-1',
        conversationRef: 'channel:123',
        threadRef: 'thread:456',
        replyToMessageRef: 'discord:message:1',
        bodyKind: 'text/markdown',
        bodyText: 'retry me',
        createdAt: '2026-04-23T02:00:00.000Z',
      })
      fixture.interfaceStore.deliveries.fail({
        deliveryRequestId: 'dr_failed_requeue',
        failureCode: 'gateway_timeout',
        failureMessage: 'discord timed out',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_failed_requeue/requeue',
        body: {
          requeuedBy: 'smokey',
        },
      })
      const payload = await fixture.json<{
        delivery: {
          deliveryRequestId: string
          linkedFailureId: string
          status: 'queued'
          gatewayId: string
          conversationRef: string
          threadRef?: string
          body: { text: string }
        }
      }>(response)

      expect(response.status).toBe(201)
      expect(payload.delivery).toMatchObject({
        linkedFailureId: 'dr_failed_requeue',
        status: 'queued',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:456',
        body: { text: 'retry me' },
      })
      expect(payload.delivery.deliveryRequestId).not.toBe('dr_failed_requeue')
      expect(fixture.interfaceStore.deliveries.get('dr_failed_requeue')).toMatchObject({
        deliveryRequestId: 'dr_failed_requeue',
        status: 'failed',
      })
    })
  })

  test('returns not_found for requeue on an unknown delivery id', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_missing/requeue',
        body: {
          requeuedBy: 'smokey',
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(404)
      expect(payload.error.code).toBe('not_found')
    })
  })

  test('returns delivery_not_requeueable when the source delivery is not failed', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_not_failed',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'still queued',
        createdAt: '2026-04-23T03:00:00.000Z',
      })

      const response = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_not_failed/requeue',
        body: {
          requeuedBy: 'smokey',
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(409)
      expect(payload.error.code).toBe('delivery_not_requeueable')
    })
  })
})
