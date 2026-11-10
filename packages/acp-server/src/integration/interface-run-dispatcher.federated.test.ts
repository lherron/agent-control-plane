import { afterEach, describe, expect, test } from 'bun:test'
import {
  cleanupFixtureDirs,
  createHrcDb,
  createInterfaceStore,
} from '../../test/fixtures/interface-run-dispatcher.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

afterEach(cleanupFixtureDirs)

describe('interface run dispatcher federated message reconciliation', () => {
  test('finalizes a federated interface run from HRC durable message correlation', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:remote-discord',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_remote',
            conversationRef: 'channel:remote',
            threadRef: 'thread:remote',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
          hrcSemanticMessage: {
            requestMessageId: 'msg-remote-request',
            rootMessageId: 'msg-remote-request',
            afterSeq: 42,
            localNodeId: 'svc',
            homeNodeId: 'lab',
          },
        },
      },
    })
    const waitCalls: unknown[] = []
    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      hrcClient: {
        waitMessage: async (request: unknown) => {
          waitCalls.push(request)
          return {
            matched: true as const,
            record: {
              messageSeq: 57,
              messageId: 'msg-remote-response',
              createdAt: '2026-07-21T01:31:00.000Z',
              kind: 'dm' as const,
              phase: 'response' as const,
              from: {
                kind: 'session' as const,
                sessionRef: `${sessionRef.scopeRef}/lane:main`,
              },
              to: { kind: 'entity' as const, entity: 'human' },
              replyToMessageId: 'msg-remote-request',
              rootMessageId: 'msg-remote-request',
              body: 'The codeword is ORCHID and the answer is 95.',
              bodyFormat: 'text/plain' as const,
              execution: { state: 'not_applicable' as const },
            },
          }
        },
      },
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(waitCalls).toEqual([
      {
        thread: { rootMessageId: 'msg-remote-request' },
        kinds: ['dm'],
        phases: ['response'],
        afterSeq: 42,
        deliveryMessageId: 'msg-remote-request',
        timeoutMs: 1,
      },
    ])
    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toMatchObject([
      {
        runId: run.runId,
        conversationRef: 'channel:remote',
        threadRef: 'thread:remote',
        bodyText: 'The codeword is ORCHID and the answer is 95.',
      },
    ])
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('turns a federated outbox failure into a terminal interface delivery', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:hrc-runtime:task:remote-failure',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_remote',
            conversationRef: 'channel:remote',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
          hrcSemanticMessage: {
            requestMessageId: 'msg-failed-request',
            rootMessageId: 'msg-failed-request',
            afterSeq: 84,
            localNodeId: 'svc',
            homeNodeId: 'lab',
          },
        },
      },
    })
    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      hrcClient: {
        waitMessage: async () => ({
          matched: false as const,
          reason: 'delivery_failed' as const,
          messageId: 'msg-failed-request',
          errorCode: 'peer_delivery_failed',
          errorMessage: 'lab rejected the envelope',
        }),
      },
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(runStore.getRun(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'stale_context',
      errorMessage: 'lab rejected the envelope',
    })
    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toMatchObject([
      {
        runId: run.runId,
        bodyText: 'The agent encountered an error: lab rejected the envelope',
      },
    ])
    interfaceStore.close()
  })

  test.each([
    {
      retryable: false,
      code: 'stale_context',
      message: 'max3 rejected the envelope',
      reason: 'routed-elsewhere',
    },
    {
      retryable: true,
      code: 'runtime_unavailable',
      message: 'max3 is unreachable',
      reason: 'peer_unreachable',
    },
  ])(
    'delivery retryable=$retryable projects $code and preserves its typed cause',
    async ({ retryable, code, message, reason }) => {
      const hrc = createHrcDb()
      const interfaceStore = createInterfaceStore()
      const runStore = new InMemoryRunStore()
      const run = runStore.createRun({
        sessionRef: {
          scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-failure',
          laneRef: 'main',
        },
        status: 'running',
        metadata: {
          meta: {
            hrcSemanticMessage: {
              requestMessageId: 'msg-t4-failed-request',
              rootMessageId: 'msg-t4-failed-request',
              afterSeq: 84,
              localNodeId: 'svc',
              homeNodeId: 'max3',
            },
          },
        },
      })
      runStore.updateRun(run.runId, { transport: 'federated-message' })
      const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
        runStore,
        interfaceStore,
        hrc: hrc.routes,
        hrcClient: {
          waitMessage: async () =>
            ({
              matched: false as const,
              reason: 'delivery_failed' as const,
              messageId: 'msg-t4-failed-request',
              errorCode: 'peer_delivery_failed',
              errorMessage: message,
              errorReason: reason,
              retryable,
              homeNodeId: 'max3',
            }) as any,
        },
        config: { intervalMs: 1, staleTimeoutMs: 60_000 },
      })

      await dispatcher.runOnce()

      expect(runStore.getRun(run.runId)).toMatchObject({
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        metadata: {
          meta: {
            hrcSemanticMessage: {
              terminal: {
                state: 'failed',
                error: {
                  code,
                  message,
                  reason,
                  retryable,
                  homeNodeId: 'max3',
                },
              },
            },
          },
        },
      })
      interfaceStore.close()
    }
  )

  test('times out a never-answered plain federated-message run', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = runStore.createRun({
      sessionRef: {
        scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-timeout',
        laneRef: 'main',
      },
      status: 'running',
      metadata: {
        meta: {
          hrcSemanticMessage: {
            requestMessageId: 'msg-t4-timeout-request',
            rootMessageId: 'msg-t4-timeout-request',
            afterSeq: 91,
            localNodeId: 'svc',
            homeNodeId: 'max3',
          },
        },
      },
    })
    runStore.updateRun(run.runId, { transport: 'federated-message' })
    await Bun.sleep(2)
    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      hrcClient: {
        waitMessage: async () => ({ matched: false as const, reason: 'timeout' as const }),
      },
      config: { intervalMs: 1, staleTimeoutMs: 1 },
    })

    await dispatcher.runOnce()

    expect(runStore.getRun(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'turn_timeout',
      metadata: {
        meta: {
          hrcSemanticMessage: {
            terminal: {
              state: 'failed',
              error: {
                code: 'turn_timeout',
                reason: 'response_timeout',
                retryable: false,
                homeNodeId: 'max3',
              },
            },
          },
        },
      },
    })
    interfaceStore.close()
  })

  test('does not overwrite cancellation while awaiting a federated-message response', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = runStore.createRun({
      sessionRef: {
        scopeRef: 'agent:scribe:project:hrc-runtime:task:T-06805-t4-cancel',
        laneRef: 'main',
      },
      status: 'running',
      metadata: {
        meta: {
          hrcSemanticMessage: {
            requestMessageId: 'msg-t4-cancel-request',
            rootMessageId: 'msg-t4-cancel-request',
            afterSeq: 104,
            localNodeId: 'svc',
            homeNodeId: 'max3',
          },
        },
      },
    })
    runStore.updateRun(run.runId, { transport: 'federated-message' })
    let releaseWait: (() => void) | undefined
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      hrcClient: {
        waitMessage: async () => {
          await waitGate
          return {
            matched: true as const,
            record: {
              messageSeq: 105,
              messageId: 'msg-t4-cancel-response',
              createdAt: '2026-07-22T22:33:00.000Z',
              kind: 'dm' as const,
              phase: 'response' as const,
              from: {
                kind: 'session' as const,
                sessionRef: `${run.scopeRef}/lane:main`,
              },
              to: { kind: 'entity' as const, entity: 'human' },
              replyToMessageId: 'msg-t4-cancel-request',
              rootMessageId: 'msg-t4-cancel-request',
              body: 'late response after cancellation',
              bodyFormat: 'text/plain' as const,
              execution: { state: 'not_applicable' as const },
            },
          }
        },
      },
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    const reconciliation = dispatcher.runOnce()
    runStore.updateRun(run.runId, { status: 'cancelled', errorCode: 'cancelled' })
    releaseWait?.()
    await reconciliation

    const cancelled = runStore.getRun(run.runId)
    expect(cancelled).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' })
    expect(
      (
        cancelled?.metadata?.['meta'] as
          | { hrcSemanticMessage?: { terminal?: unknown } | undefined }
          | undefined
      )?.hrcSemanticMessage?.terminal
    ).toBeUndefined()
    interfaceStore.close()
  })
})
