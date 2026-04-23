import { describe, expect, test } from 'bun:test'

import type { DeliveryTarget } from 'acp-core'
import type { InterfaceStore } from 'acp-interface-store'
import { type SessionRef, normalizeSessionRef } from 'agent-scope'

import { withWiredServer } from '../fixtures/wired-server.js'

type ResolvedDeliveryDestination = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}

type ResolveDeliveryTargetResult =
  | { ok: true; destination: ResolvedDeliveryDestination }
  | { ok: false; code: 'not_found' | 'no_last_context' | 'invalid_target' }

type FutureDeliveryTargetResolver = {
  resolve(target: DeliveryTarget): ResolveDeliveryTargetResult
}

type FutureLastDeliveryContextStore = {
  getLastDelivery(sessionRef: SessionRef):
    | {
        gatewayId: string
        conversationRef: string
        threadRef?: string | undefined
        deliveryRequestId: string
        ackedAt: string
      }
    | undefined
}

type FutureInterfaceStore = InterfaceStore & {
  deliveryTargets?: FutureDeliveryTargetResolver | undefined
  lastDeliveryContext?: FutureLastDeliveryContextStore | undefined
}

function getFutureStore(store: InterfaceStore): FutureInterfaceStore {
  return store as FutureInterfaceStore
}

describe('delivery target last-context invariant', () => {
  test('failed deliveries do not create last context when nothing has ever acked', async () => {
    await withWiredServer(async (fixture) => {
      const sessionRef = normalizeSessionRef({
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
      })

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_fail_first',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        conversationRef: 'channel:first',
        threadRef: 'thread:first',
        bodyKind: 'text/markdown',
        bodyText: 'first failure',
        createdAt: '2026-04-23T04:00:00.000Z',
      })

      const failResponse = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_fail_first/fail',
        body: {
          code: 'gateway_timeout',
          message: 'discord timed out',
        },
      })

      expect(failResponse.status).toBe(200)
      expect(
        getFutureStore(fixture.interfaceStore).lastDeliveryContext?.getLastDelivery(sessionRef)
      ).toBe(undefined)
      expect(
        getFutureStore(fixture.interfaceStore).deliveryTargets?.resolve({
          kind: 'last',
          sessionRef,
        })
      ).toEqual({
        ok: false,
        code: 'no_last_context',
      })
    })
  })

  test('failed deliveries preserve the prior acked destination for last resolution', async () => {
    await withWiredServer(async (fixture) => {
      const futureStore = getFutureStore(fixture.interfaceStore)
      const sessionRef = normalizeSessionRef({
        scopeRef: `agent:smokey:project:${fixture.seed.projectId}`,
      })

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_ack_prior',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        conversationRef: 'channel:acked',
        threadRef: 'thread:acked',
        bodyKind: 'text/markdown',
        bodyText: 'prior success',
        createdAt: '2026-04-23T04:05:00.000Z',
      })

      const ackResponse = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_ack_prior/ack',
      })
      expect(ackResponse.status).toBe(200)

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: 'dr_fail_after_ack',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_1',
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        conversationRef: 'channel:failed',
        threadRef: 'thread:failed',
        bodyKind: 'text/markdown',
        bodyText: 'later failure',
        createdAt: '2026-04-23T04:10:00.000Z',
      })

      const failResponse = await fixture.request({
        method: 'POST',
        path: '/v1/gateway/deliveries/dr_fail_after_ack/fail',
        body: {
          code: 'gateway_timeout',
          message: 'discord timed out',
        },
      })
      expect(failResponse.status).toBe(200)

      expect(futureStore.lastDeliveryContext?.getLastDelivery(sessionRef)).toEqual({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:acked',
        threadRef: 'thread:acked',
        deliveryRequestId: 'dr_ack_prior',
        ackedAt: expect.any(String),
      })
      expect(
        futureStore.deliveryTargets?.resolve({
          kind: 'last',
          sessionRef,
        })
      ).toEqual({
        ok: true,
        destination: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:acked',
          threadRef: 'thread:acked',
        },
      })
    })
  })
})
