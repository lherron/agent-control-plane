import { describe, expect, test } from 'bun:test'

import type { DeliveryTarget } from 'acp-core'
import { type SessionRef, normalizeSessionRef } from 'agent-scope'

import type { InterfaceStore } from '../src/index.js'
import { withInterfaceStore } from './helpers.js'

type ResolvedDeliveryDestination = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
}

type ResolveDeliveryTargetResult =
  | { ok: true; destination: ResolvedDeliveryDestination }
  | { ok: false; code: 'not_found' | 'no_last_context' | 'invalid_target' }

type LastDeliveryRecord = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  deliveryRequestId: string
  ackedAt: string
}

type FutureDeliveryTargetResolver = {
  resolve(target: DeliveryTarget): ResolveDeliveryTargetResult
}

type FutureLastDeliveryContextStore = {
  recordAckedDelivery(sessionRef: SessionRef, record: LastDeliveryRecord): void
}

type FutureInterfaceStore = InterfaceStore & {
  deliveryTargets?: FutureDeliveryTargetResolver | undefined
  lastDeliveryContext?: FutureLastDeliveryContextStore | undefined
}

function getFutureStore(store: InterfaceStore): FutureInterfaceStore {
  return store as FutureInterfaceStore
}

describe('delivery target resolver', () => {
  test('resolves binding targets to the binding destination', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-live',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        threadRef: 'thread:456',
        scopeRef: 'agent:smokey:project:test',
        laneRef: 'main',
        status: 'active',
        createdAt: '2026-04-23T01:00:00.000Z',
        updatedAt: '2026-04-23T01:00:00.000Z',
      })

      const resolved = getFutureStore(store).deliveryTargets?.resolve({
        kind: 'binding',
        bindingId: 'bind-live',
      })

      expect(resolved).toEqual({
        ok: true,
        destination: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          threadRef: 'thread:456',
        },
      })
    })
  })

  test('returns not_found for disabled bindings', () => {
    withInterfaceStore(({ store }) => {
      store.bindings.create({
        bindingId: 'bind-disabled',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:456',
        scopeRef: 'agent:smokey:project:test',
        laneRef: 'main',
        status: 'disabled',
        createdAt: '2026-04-23T01:00:00.000Z',
        updatedAt: '2026-04-23T01:00:00.000Z',
      })

      const resolved = getFutureStore(store).deliveryTargets?.resolve({
        kind: 'binding',
        bindingId: 'bind-disabled',
      })

      expect(resolved).toEqual({
        ok: false,
        code: 'not_found',
      })
    })
  })

  test('returns no_last_context when no successful delivery has been acked', () => {
    withInterfaceStore(({ store }) => {
      const resolved = getFutureStore(store).deliveryTargets?.resolve({
        kind: 'last',
        sessionRef: normalizeSessionRef({
          scopeRef: 'agent:smokey:project:test',
        }),
      })

      expect(resolved).toEqual({
        ok: false,
        code: 'no_last_context',
      })
    })
  })

  test('resolves last targets from the prior acked delivery context', () => {
    withInterfaceStore(({ store }) => {
      const futureStore = getFutureStore(store)
      const sessionRef = normalizeSessionRef({
        scopeRef: 'agent:smokey:project:test',
      })

      futureStore.lastDeliveryContext?.recordAckedDelivery(sessionRef, {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:last',
        threadRef: 'thread:last',
        deliveryRequestId: 'dr-last',
        ackedAt: '2026-04-23T02:00:00.000Z',
      })

      const resolved = futureStore.deliveryTargets?.resolve({
        kind: 'last',
        sessionRef,
      })

      expect(resolved).toEqual({
        ok: true,
        destination: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:last',
          threadRef: 'thread:last',
        },
      })
    })
  })

  test('passes through explicit targets with non-empty fields', () => {
    withInterfaceStore(({ store }) => {
      const resolved = getFutureStore(store).deliveryTargets?.resolve({
        kind: 'explicit',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:explicit',
        threadRef: 'thread:explicit',
      })

      expect(resolved).toEqual({
        ok: true,
        destination: {
          gatewayId: 'discord_prod',
          conversationRef: 'channel:explicit',
          threadRef: 'thread:explicit',
        },
      })
    })
  })

  test('rejects explicit targets with empty required fields', () => {
    withInterfaceStore(({ store }) => {
      const resolved = getFutureStore(store).deliveryTargets?.resolve({
        kind: 'explicit',
        gatewayId: '',
        conversationRef: 'channel:explicit',
      })

      expect(resolved).toEqual({
        ok: false,
        code: 'invalid_target',
      })
    })
  })
})
