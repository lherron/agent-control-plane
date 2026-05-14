import { describe, expect, test } from 'bun:test'

import { withInterfaceStore } from './helpers.js'

describe('DeliveryRequestRepo', () => {
  test('enqueues, preserves queue order, leases, and acks deliveries', () => {
    withInterfaceStore(({ store }) => {
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-1',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-1',
        inputAttemptId: 'attempt-1',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
        replyToMessageRef: 'discord:message:1',
        bodyKind: 'text/markdown',
        bodyText: 'First reply',
        bodyAttachments: [
          {
            kind: 'file',
            path: '/tmp/generated.png',
            filename: 'generated.png',
            contentType: 'image/png',
            sizeBytes: 42,
            alt: 'Generated preview',
          },
        ],
        createdAt: '2026-04-20T15:10:00.000Z',
      })
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-2',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-1',
        inputAttemptId: 'attempt-1',
        conversationRef: 'channel:123',
        threadRef: 'thread:555',
        bodyKind: 'text/markdown',
        bodyText: 'Second reply',
        createdAt: '2026-04-20T15:10:00.000Z',
      })

      expect(
        store.deliveries
          .listQueuedForGateway('discord_prod')
          .map((request) => request.deliveryRequestId)
      ).toEqual(['dr-1', 'dr-2'])

      const leased = store.deliveries.leaseNext('discord_prod')
      expect(leased?.deliveryRequestId).toBe('dr-1')
      expect(leased?.status).toBe('delivering')
      expect(leased?.bodyAttachments).toEqual([
        {
          kind: 'file',
          path: '/tmp/generated.png',
          filename: 'generated.png',
          contentType: 'image/png',
          sizeBytes: 42,
          alt: 'Generated preview',
        },
      ])

      const acked = store.deliveries.ack('dr-1', '2026-04-20T15:11:00.000Z')
      expect(acked?.status).toBe('delivered')
      expect(acked?.deliveredAt).toBe('2026-04-20T15:11:00.000Z')
      expect(acked?.failureCode).toBeUndefined()
      expect(acked?.failureMessage).toBeUndefined()

      const next = store.deliveries.leaseNext('discord_prod')
      expect(next?.deliveryRequestId).toBe('dr-2')
      expect(next?.status).toBe('delivering')
    })
  })

  test('retains failure code and message when delivery fails', () => {
    withInterfaceStore(({ store }) => {
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-fail',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-2',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: 'Will fail',
        createdAt: '2026-04-20T15:20:00.000Z',
      })

      expect(store.deliveries.leaseNext('discord_prod')?.deliveryRequestId).toBe('dr-fail')

      const failed = store.deliveries.fail({
        deliveryRequestId: 'dr-fail',
        failureCode: 'discord_forbidden',
        failureMessage: 'Missing permission to post in target thread',
      })

      expect(failed?.status).toBe('failed')
      expect(failed?.failureCode).toBe('discord_forbidden')
      expect(failed?.failureMessage).toBe('Missing permission to post in target thread')
      expect(store.deliveries.get('dr-fail')).toEqual(failed)
    })
  })

  test('round-trips synthesized launch signal outcome metadata through queued delivery storage', () => {
    withInterfaceStore(({ store }) => {
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-signalled',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-signalled',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: '',
        outcome: {
          state: 'degraded',
          reason: 'launch_signalled',
          source: 'launch_exit_synthesized',
          signal: 'SIGTERM',
        },
        createdAt: '2026-04-20T15:30:00.000Z',
      } as Parameters<typeof store.deliveries.enqueue>[0])

      expect(store.deliveries.get('dr-signalled')?.outcome).toEqual({
        state: 'degraded',
        reason: 'launch_signalled',
        source: 'launch_exit_synthesized',
        signal: 'SIGTERM',
      })
      expect(store.deliveries.leaseNext('discord_prod')?.outcome).toEqual({
        state: 'degraded',
        reason: 'launch_signalled',
        source: 'launch_exit_synthesized',
        signal: 'SIGTERM',
      })
    })
  })

  test('round-trips synthesized launch failure outcome metadata through queued delivery storage', () => {
    withInterfaceStore(({ store }) => {
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-failed-launch',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-failed-launch',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: '',
        outcome: {
          state: 'degraded',
          reason: 'launch_failed',
          source: 'launch_exit_synthesized',
          exitCode: 42,
        },
        createdAt: '2026-04-20T15:31:00.000Z',
      } as Parameters<typeof store.deliveries.enqueue>[0])

      expect(store.deliveries.get('dr-failed-launch')?.outcome).toEqual({
        state: 'degraded',
        reason: 'launch_failed',
        source: 'launch_exit_synthesized',
        exitCode: 42,
      })
      expect(store.deliveries.leaseNext('discord_prod')?.outcome).toEqual({
        state: 'degraded',
        reason: 'launch_failed',
        source: 'launch_exit_synthesized',
        exitCode: 42,
      })
    })
  })

  test('round-trips no assistant content error details through queued delivery storage', () => {
    withInterfaceStore(({ store }) => {
      store.deliveries.enqueue({
        deliveryRequestId: 'dr-no-assistant-content',
        gatewayId: 'discord_prod',
        bindingId: 'bind-1',
        scopeRef: 'scope:project',
        laneRef: 'main',
        runId: 'run-no-assistant-content',
        conversationRef: 'channel:123',
        bodyKind: 'text/markdown',
        bodyText: '',
        outcome: {
          state: 'degraded',
          reason: 'no_assistant_content',
          source: 'codex_app_server',
          details: {
            errorMessage: 'driver exploded before turn',
          },
        },
        createdAt: '2026-04-20T15:32:00.000Z',
      })

      const expectedOutcome = {
        state: 'degraded',
        reason: 'no_assistant_content',
        source: 'codex_app_server',
        details: {
          errorMessage: 'driver exploded before turn',
        },
      }

      expect(store.deliveries.get('dr-no-assistant-content')?.outcome).toEqual(expectedOutcome)
      expect(store.deliveries.leaseNext('discord_prod')?.outcome).toEqual(expectedOutcome)
    })
  })
})
