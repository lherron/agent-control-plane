import { describe, expect, test } from 'bun:test'

import { type SessionRef, normalizeSessionRef } from 'agent-scope'

import type { InterfaceStore } from '../src/index.js'
import { withInterfaceStore } from './helpers.js'

type LastDeliveryRecord = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  deliveryRequestId: string
  ackedAt: string
}

type FailedDeliveryRecord = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  deliveryRequestId: string
  failedAt: string
}

type FutureLastDeliveryContextStore = {
  recordAckedDelivery(sessionRef: SessionRef, record: LastDeliveryRecord): void
  recordFailedDelivery(sessionRef: SessionRef, record: FailedDeliveryRecord): void
  getLastDelivery(sessionRef: SessionRef): LastDeliveryRecord | undefined
}

type FutureInterfaceStore = InterfaceStore & {
  lastDeliveryContext?: FutureLastDeliveryContextStore | undefined
}

function getFutureStore(store: InterfaceStore): FutureInterfaceStore {
  return store as FutureInterfaceStore
}

describe('last delivery context store', () => {
  test('keys rows by canonical sessionRef scope and lane', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)
      const implicitMain = normalizeSessionRef({ scopeRef: 'agent:smokey:project:test' })
      const explicitMain = normalizeSessionRef({
        scopeRef: 'agent:smokey:project:test',
        laneRef: 'main',
      })

      futureStore.lastDeliveryContext?.recordAckedDelivery(implicitMain, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:canonical',
        threadRef: 'thread:canonical',
        deliveryRequestId: 'dr-canonical',
        ackedAt: '2026-04-23T02:10:00.000Z',
      })

      expect(futureStore.lastDeliveryContext?.getLastDelivery(explicitMain)).toEqual({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:canonical',
        threadRef: 'thread:canonical',
        deliveryRequestId: 'dr-canonical',
        ackedAt: '2026-04-23T02:10:00.000Z',
      })
    })
  })

  test('upserts acked deliveries and lets the later ackedAt win', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)
      const sessionRef = normalizeSessionRef({ scopeRef: 'agent:smokey:project:test' })

      futureStore.lastDeliveryContext?.recordAckedDelivery(sessionRef, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:old',
        deliveryRequestId: 'dr-old',
        ackedAt: '2026-04-23T02:00:00.000Z',
      })
      futureStore.lastDeliveryContext?.recordAckedDelivery(sessionRef, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:new',
        threadRef: 'thread:new',
        deliveryRequestId: 'dr-new',
        ackedAt: '2026-04-23T02:30:00.000Z',
      })

      expect(futureStore.lastDeliveryContext?.getLastDelivery(sessionRef)).toEqual({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:new',
        threadRef: 'thread:new',
        deliveryRequestId: 'dr-new',
        ackedAt: '2026-04-23T02:30:00.000Z',
      })
    })
  })

  test('ignores failed deliveries and preserves the prior acked destination', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)
      const sessionRef = normalizeSessionRef({ scopeRef: 'agent:smokey:project:test' })

      futureStore.lastDeliveryContext?.recordAckedDelivery(sessionRef, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:acked',
        threadRef: 'thread:acked',
        deliveryRequestId: 'dr-acked',
        ackedAt: '2026-04-23T02:00:00.000Z',
      })
      futureStore.lastDeliveryContext?.recordFailedDelivery(sessionRef, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:failed',
        threadRef: 'thread:failed',
        deliveryRequestId: 'dr-failed',
        failedAt: '2026-04-23T03:00:00.000Z',
      })

      expect(futureStore.lastDeliveryContext?.getLastDelivery(sessionRef)).toEqual({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:acked',
        threadRef: 'thread:acked',
        deliveryRequestId: 'dr-acked',
        ackedAt: '2026-04-23T02:00:00.000Z',
      })
    })
  })
})
