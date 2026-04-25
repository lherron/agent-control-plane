import { describe, expect, test } from 'bun:test'

import type { DeliveryRequest } from '../src/index.js'
import type { InterfaceStore } from '../src/open-store.js'
import { withInterfaceStore } from './helpers.js'

type RequeuedDelivery = Omit<DeliveryRequest, 'status'> & {
  status: 'queued'
  linkedFailureId: string
}

type RequeueDeliveryResult =
  | { ok: true; delivery: RequeuedDelivery }
  | { ok: false; code: 'wrong_state' | 'not_found' }

type FutureInterfaceStore = InterfaceStore & {
  deliveries: InterfaceStore['deliveries'] & {
    requeue?: (deliveryRequestId: string, input: { requeuedBy: string }) => RequeueDeliveryResult
  }
}

function getFutureStore(store: InterfaceStore): FutureInterfaceStore {
  return store as FutureInterfaceStore
}

describe('delivery requeue', () => {
  test('creates a new queued delivery linked to the failed request and preserves the source row', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)

      store.deliveries.enqueue({
        deliveryRequestId: 'dr-failed',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: 'agent:smokey:project:test',
        laneRef: 'main',
        runId: 'run-1',
        inputAttemptId: 'attempt-1',
        conversationRef: 'channel:123',
        threadRef: 'thread:456',
        replyToMessageRef: 'discord:message:1',
        bodyKind: 'text/markdown',
        bodyText: 'retry me',
        bodyAttachments: [
          {
            kind: 'file',
            path: '/tmp/retry.png',
            filename: 'retry.png',
            contentType: 'image/png',
            sizeBytes: 10,
            alt: 'Retry alt',
          },
        ],
        createdAt: '2026-04-23T02:00:00.000Z',
      })
      store.deliveries.fail({
        deliveryRequestId: 'dr-failed',
        failureCode: 'gateway_timeout',
        failureMessage: 'discord timed out',
      })

      const result = futureStore.deliveries.requeue?.('dr-failed', {
        requeuedBy: 'smokey',
      })

      expect(result).toMatchObject({
        ok: true,
        delivery: {
          deliveryRequestId: expect.not.stringMatching(/^dr-failed$/),
          linkedFailureId: 'dr-failed',
          actor: { kind: 'system', id: 'acp-local' },
          gatewayId: 'discord_prod',
          bindingId: 'ifb_1',
          scopeRef: 'agent:smokey:project:test',
          laneRef: 'main',
          runId: 'run-1',
          inputAttemptId: 'attempt-1',
          conversationRef: 'channel:123',
          threadRef: 'thread:456',
          replyToMessageRef: 'discord:message:1',
          bodyKind: 'text/markdown',
          bodyText: 'retry me',
          bodyAttachments: [
            {
              kind: 'file',
              path: '/tmp/retry.png',
              filename: 'retry.png',
              contentType: 'image/png',
              sizeBytes: 10,
              alt: 'Retry alt',
            },
          ],
          status: 'queued',
          createdAt: expect.any(String),
        },
      })
      expect(store.deliveries.get('dr-failed')).toMatchObject({
        deliveryRequestId: 'dr-failed',
        status: 'failed',
        failureCode: 'gateway_timeout',
        failureMessage: 'discord timed out',
      })
    })
  })

  test('rejects requeue for deliveries that are not failed', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)

      store.deliveries.enqueue({
        deliveryRequestId: 'dr-queued',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: 'agent:smokey:project:test',
        laneRef: 'main',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'still queued',
        createdAt: '2026-04-23T02:00:00.000Z',
      })

      expect(
        futureStore.deliveries.requeue?.('dr-queued', {
          requeuedBy: 'smokey',
        })
      ).toEqual({
        ok: false,
        code: 'wrong_state',
      })
    })
  })
})
