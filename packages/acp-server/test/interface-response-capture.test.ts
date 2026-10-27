import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from 'acp-interface-store'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { createInterfaceResponseCapture } from '../src/delivery/interface-response-capture.js'
import { InMemoryRunStore } from '../src/domain/run-store.js'
import type { AcpServerDeps } from '../src/index.js'
import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

type LaunchInput = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

const SOURCE = {
  gatewayId: 'discord_prod',
  conversationRef: 'channel:123',
  threadRef: 'thread:456',
  messageRef: 'discord:message:789',
  authorRef: 'discord:user:999',
} as const

const runtimeResolver: AcpServerDeps['runtimeResolver'] = async () => ({
  agentRoot: '/tmp/agents/curly',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
  harness: { provider: 'openai', interactive: true },
})

function assistantMessageEnd(text: string, messageId = 'msg-1'): UnifiedSessionEvent {
  return {
    type: 'message_end',
    messageId,
    message: { role: 'assistant', content: text },
  }
}

function turnEnd(payload: Record<string, unknown>): UnifiedSessionEvent {
  return { type: 'turn_end', payload } as unknown as UnifiedSessionEvent
}

/**
 * POST /v1/interface/messages to a bound conversation; the launcher stub stands
 * in for HRC and replays `events` through the launch's onEvent callback.
 */
async function withInterfaceLaunch<T>(
  events:
    | UnifiedSessionEvent[]
    | ((input: LaunchInput, fixture: WiredServerFixture) => Promise<void>),
  assert: (input: {
    fixture: WiredServerFixture
    payload: { inputAttemptId: string; runId: string }
    scopeRef: string
  }) => Promise<T> | T
): Promise<T> {
  let current: WiredServerFixture | undefined
  return withWiredServer(
    async (fixture) => {
      current = fixture
      const scopeRef = `agent:curly:project:${fixture.seed.projectId}`
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_123',
        gatewayId: SOURCE.gatewayId,
        conversationRef: SOURCE.conversationRef,
        scopeRef,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/interface/messages',
        body: { source: SOURCE, content: 'Reply please.' },
      })
      expect(response.status).toBe(201)
      const payload = await fixture.json<{ inputAttemptId: string; runId: string }>(response)
      return assert({ fixture, payload, scopeRef })
    },
    {
      runtimeResolver,
      launchRoleScopedRun: async (input) => {
        if (typeof events === 'function') {
          await events(input, current as WiredServerFixture)
        } else {
          for (const event of events) await input.onEvent?.(event)
        }
        return { runId: input.acpRunId ?? 'launch-run', sessionId: 'session-capture' }
      },
    }
  )
}

describe('interface response capture', () => {
  test('a visible assistant message_end enqueues exactly one delivery carrying the source binding, thread, attempt and reply anchor', async () => {
    await withInterfaceLaunch(
      [assistantMessageEnd('Hello from ACP.')],
      ({ fixture, payload, scopeRef }) => {
        const deliveries = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0]).toMatchObject({
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          scopeRef,
          laneRef: 'main',
          runId: payload.runId,
          inputAttemptId: payload.inputAttemptId,
          conversationRef: SOURCE.conversationRef,
          threadRef: SOURCE.threadRef,
          replyToMessageRef: SOURCE.messageRef,
          bodyKind: 'text/markdown',
          bodyText: 'Hello from ACP.',
          status: 'queued',
        })
      }
    )
  })

  test('turn_end finalOutput is delivered in preference to the turn message text', async () => {
    await withInterfaceLaunch(
      [
        turnEnd({
          finalOutput: 'Final answer from turn.completed.',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'fallback should not be used' }],
          },
        }),
      ],
      ({ fixture, payload }) => {
        expect(fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([
          expect.objectContaining({
            inputAttemptId: payload.inputAttemptId,
            bodyText: 'Final answer from turn.completed.',
            status: 'queued',
          }),
        ])
      }
    )
  })

  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'synthesized completion with no assistant content',
      {
        success: true,
        transport: 'headless',
        source: 'launch_exit_synthesized',
        outcome: {
          state: 'degraded',
          reason: 'no_assistant_content',
          source: 'launch_exit_synthesized',
        },
      },
      { state: 'degraded', reason: 'no_assistant_content', source: 'launch_exit_synthesized' },
    ],
    [
      'app-server completion with blank finalOutput and message (inferred)',
      {
        success: true,
        transport: 'headless',
        source: 'codex_app_server',
        finalOutput: '',
        message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
      },
      { state: 'degraded', reason: 'no_assistant_content', source: 'codex_app_server' },
    ],
    [
      'synthesized launch signal',
      {
        type: 'turn.completed',
        source: 'launch_exit_synthesized',
        success: false,
        outcome: {
          state: 'degraded',
          reason: 'launch_signalled',
          source: 'launch_exit_synthesized',
          signal: 'SIGTERM',
        },
      },
      {
        state: 'degraded',
        reason: 'launch_signalled',
        source: 'launch_exit_synthesized',
        signal: 'SIGTERM',
      },
    ],
    [
      'synthesized launch failure',
      {
        type: 'turn.completed',
        source: 'launch_exit_synthesized',
        success: false,
        outcome: {
          state: 'degraded',
          reason: 'launch_failed',
          source: 'launch_exit_synthesized',
          exitCode: 42,
        },
      },
      {
        state: 'degraded',
        reason: 'launch_failed',
        source: 'launch_exit_synthesized',
        exitCode: 42,
      },
    ],
    [
      'no assistant content with error details',
      {
        type: 'turn.completed',
        source: 'codex_app_server',
        success: false,
        outcome: {
          state: 'degraded',
          reason: 'no_assistant_content',
          source: 'codex_app_server',
          details: { errorMessage: 'driver exploded before turn' },
        },
      },
      {
        state: 'degraded',
        reason: 'no_assistant_content',
        source: 'codex_app_server',
        details: { errorMessage: 'driver exploded before turn' },
      },
    ],
  ])(
    '%s → one empty-body delivery carrying the degraded outcome verbatim',
    async (_case, payload, outcome) => {
      await withInterfaceLaunch([turnEnd(payload)], ({ fixture }) => {
        const deliveries = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0]?.bodyText).toBe('')
        expect(deliveries[0]?.outcome).toEqual(outcome)
      })
    }
  )

  test('tool results and partial message updates enqueue no delivery', async () => {
    await withInterfaceLaunch(
      [
        {
          type: 'tool_execution_end',
          toolUseId: 'tool-1',
          toolName: 'Bash',
          result: { content: [{ type: 'text', text: 'tool output' }] },
        } as UnifiedSessionEvent,
        {
          type: 'message_update',
          messageId: 'msg-1',
          textDelta: 'partial only',
        } as UnifiedSessionEvent,
      ],
      ({ fixture }) => {
        expect(fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
      }
    )
  })

  test('successive replies deliver in order, stitch text around tool_use, and only the first anchors to the source message', async () => {
    await withInterfaceLaunch(
      [
        assistantMessageEnd('First reply', 'msg-1'),
        {
          type: 'message_end',
          messageId: 'msg-2',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Second' },
              { type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} },
              { type: 'text', text: ' reply' },
            ],
          },
        } as UnifiedSessionEvent,
      ],
      ({ fixture }) => {
        const deliveries = fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        expect(deliveries.map((delivery) => delivery.bodyText)).toEqual([
          'First reply',
          'Second reply',
        ])
        expect(deliveries[0]?.replyToMessageRef).toBe(SOURCE.messageRef)
        expect(deliveries[1]?.replyToMessageRef).toBeUndefined()
      }
    )
  })

  test('a run that ends without a visible reply marks its pending outbound attachments failed and delivers nothing', async () => {
    const originalConsoleWarn = console.warn
    let attachmentId: string | undefined
    let warningCount = 0
    console.warn = () => {
      warningCount += 1
    }
    try {
      await withInterfaceLaunch(
        async (input, fixture) => {
          attachmentId = fixture.interfaceStore.outboundAttachments.create({
            runId: input.acpRunId as string,
            path: '/tmp/orphan.png',
            filename: 'orphan.png',
            contentType: 'image/png',
            sizeBytes: 12,
          }).outboundAttachmentId
          await input.onEvent?.({ type: 'agent_end', reason: 'completed' } as UnifiedSessionEvent)
        },
        ({ fixture }) => {
          expect(fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
          expect(
            fixture.interfaceStore.outboundAttachments.get(attachmentId as string)?.state
          ).toBe('failed')
        }
      )
      expect(warningCount).toBe(1)
    } finally {
      console.warn = originalConsoleWarn
    }
  })

  test('a non-interface input whose launch emits a visible reply enqueues no gateway delivery', async () => {
    const launches: LaunchInput[] = []
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'plain-input-1',
            sessionRef: {
              scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
              laneRef: 'main',
            },
            content: 'plain cli input',
            meta: { source: 'plain-input' },
          },
        })
        expect(response.status).toBe(201)
        expect(launches).toHaveLength(1)
        expect(fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
      },
      {
        runtimeResolver,
        launchRoleScopedRun: async (input) => {
          launches.push(input)
          await input.onEvent?.(assistantMessageEnd('Should not deliver.'))
          return { runId: input.acpRunId ?? 'launch-run', sessionId: 'session-plain' }
        },
      }
    )
  })
})

describe('interface response capture fault tolerance (seam)', () => {
  function createTempCapture() {
    const directory = mkdtempSync(join(tmpdir(), 'acp-response-capture-'))
    const interfaceStore = openInterfaceStore({ dbPath: join(directory, 'interface.db') })
    const runStore = new InMemoryRunStore()
    const run = runStore.createRun({
      sessionRef: { scopeRef: 'agent:curly:project:demo', laneRef: 'main' },
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_123',
            conversationRef: 'channel:123',
            messageRef: 'discord:message:123',
            replyToMessageRef: 'discord:message:123',
          },
        },
      },
    })
    const capture = createInterfaceResponseCapture({ interfaceStore, runStore, runId: run.runId })
    return {
      interfaceStore,
      capture,
      cleanup() {
        interfaceStore.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  }

  async function withQuietConsoleError<T>(run: () => Promise<T>): Promise<T> {
    const original = console.error
    let errorCount = 0
    console.error = () => {
      errorCount += 1
    }
    try {
      const result = await run()
      expect(errorCount).toBe(1)
      return result
    } finally {
      console.error = original
    }
  }

  test('a malformed assistant message is swallowed, enqueues nothing, and later messages still deliver', async () => {
    const temp = createTempCapture()
    try {
      await withQuietConsoleError(() =>
        temp.capture.handler({
          type: 'message_end',
          messageId: 'msg-bad',
          message: { role: 'assistant', content: { nope: true } as unknown as string },
        })
      )
      expect(temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])

      await temp.capture.handler(assistantMessageEnd('after malformed', 'msg-next'))
      expect(
        temp.interfaceStore.deliveries
          .listQueuedForGateway('discord_prod')
          .map((delivery) => delivery.bodyText)
      ).toEqual(['after malformed'])
    } finally {
      temp.cleanup()
    }
  })

  test('a delivery store write failure is swallowed, enqueues nothing, and the capture keeps delivering after the store recovers', async () => {
    const temp = createTempCapture()
    const deliveries = temp.interfaceStore.deliveries
    const originalEnqueue = deliveries.enqueue.bind(deliveries)
    try {
      deliveries.enqueue = (() => {
        throw new Error('sqlite busy')
      }) as typeof deliveries.enqueue
      await withQuietConsoleError(() =>
        temp.capture.handler(assistantMessageEnd('enqueue fails', 'msg-fail'))
      )
      deliveries.enqueue = originalEnqueue
      expect(deliveries.listQueuedForGateway('discord_prod')).toEqual([])

      await temp.capture.handler(assistantMessageEnd('store recovered', 'msg-recovered'))
      expect(
        deliveries.listQueuedForGateway('discord_prod').map((delivery) => delivery.bodyText)
      ).toEqual(['store recovered'])
    } finally {
      deliveries.enqueue = originalEnqueue
      temp.cleanup()
    }
  })
})
