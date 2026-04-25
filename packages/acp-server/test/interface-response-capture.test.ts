import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from 'acp-interface-store'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { createInterfaceResponseCapture } from '../src/delivery/interface-response-capture.js'
import { InMemoryRunStore } from '../src/domain/run-store.js'

function createTempInterfaceStore() {
  const directory = mkdtempSync(join(tmpdir(), 'acp-response-capture-'))
  const dbPath = join(directory, 'interface.db')
  const interfaceStore = openInterfaceStore({ dbPath })

  return {
    directory,
    interfaceStore,
    cleanup() {
      interfaceStore.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function createInterfaceRun(runStore: InMemoryRunStore): {
  runId: string
  scopeRef: string
  laneRef: string
} {
  const scopeRef = 'agent:curly:project:demo'
  const laneRef = 'main'
  const run = runStore.createRun({
    sessionRef: { scopeRef, laneRef },
    metadata: {
      meta: {
        interfaceSource: {
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
          threadRef: 'thread:456',
          messageRef: 'discord:message:123',
          replyToMessageRef: 'discord:message:123',
        },
      },
    },
  })

  return { runId: run.runId, scopeRef, laneRef }
}

function assistantMessageEnd(text: string, messageId = 'msg-1'): UnifiedSessionEvent {
  return {
    type: 'message_end',
    messageId,
    message: { role: 'assistant', content: text },
  }
}

describe('interface response capture', () => {
  test('enqueues exactly one queued delivery for a completed visible assistant message', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)

    try {
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
        inputAttemptId: 'ia_123',
      })

      await capture.handler(assistantMessageEnd('Hello from ACP.'))

      const deliveries = temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]).toMatchObject({
        gatewayId: 'discord_prod',
        bindingId: 'ifb_123',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        runId: run.runId,
        inputAttemptId: 'ia_123',
        conversationRef: 'channel:123',
        threadRef: 'thread:456',
        replyToMessageRef: 'discord:message:123',
        bodyKind: 'text/markdown',
        bodyText: 'Hello from ACP.',
        status: 'queued',
      })
    } finally {
      temp.cleanup()
    }
  })

  test('ignores tool and partial events', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)

    try {
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler({
        type: 'tool_execution_end',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        result: { content: [{ type: 'text', text: 'tool output' }] },
      })
      await capture.handler({
        type: 'message_update',
        messageId: 'msg-1',
        textDelta: 'partial only',
      })

      expect(temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
    } finally {
      temp.cleanup()
    }
  })

  test('preserves per-run ordering and only anchors the first reply', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)

    try {
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler(assistantMessageEnd('First reply', 'msg-1'))
      await capture.handler({
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
      })

      const deliveries = temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(deliveries).toHaveLength(2)
      expect(deliveries.map((delivery) => delivery.bodyText)).toEqual([
        'First reply',
        'Second reply',
      ])
      expect(deliveries[0]?.replyToMessageRef).toBe('discord:message:123')
      expect(deliveries[1]?.replyToMessageRef).toBeUndefined()
    } finally {
      temp.cleanup()
    }
  })

  test('consumes pending outbound attachments on the next visible assistant delivery', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)

    try {
      const pending = temp.interfaceStore.outboundAttachments.create({
        runId: run.runId,
        path: '/tmp/generated.png',
        filename: 'generated.png',
        contentType: 'image/png',
        sizeBytes: 42,
        alt: 'Generated preview',
        createdAt: '2026-04-24T20:00:00.000Z',
      })
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler(assistantMessageEnd('Image is ready.'))

      const deliveries = temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.bodyAttachments).toEqual([
        {
          kind: 'file',
          path: '/tmp/generated.png',
          filename: 'generated.png',
          contentType: 'image/png',
          sizeBytes: 42,
          alt: 'Generated preview',
        },
      ])
      expect(
        temp.interfaceStore.outboundAttachments.get(pending.outboundAttachmentId)
      ).toMatchObject({
        state: 'consumed',
        consumedByDeliveryRequestId: deliveries[0]?.deliveryRequestId,
      })
    } finally {
      temp.cleanup()
    }
  })

  test('marks pending outbound attachments failed when the run ends without a visible reply', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)
    const consoleWarn = mock(() => {})
    const originalConsoleWarn = console.warn

    try {
      console.warn = consoleWarn as typeof console.warn
      const pending = temp.interfaceStore.outboundAttachments.create({
        runId: run.runId,
        path: '/tmp/orphan.png',
        filename: 'orphan.png',
        contentType: 'image/png',
        sizeBytes: 12,
      })
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler({ type: 'agent_end', reason: 'completed' })

      expect(temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
      expect(temp.interfaceStore.outboundAttachments.get(pending.outboundAttachmentId)?.state).toBe(
        'failed'
      )
      expect(consoleWarn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = originalConsoleWarn
      temp.cleanup()
    }
  })

  test('skips non-interface runs', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = runStore.createRun({
      sessionRef: { scopeRef: 'agent:curly:project:demo', laneRef: 'main' },
      metadata: { meta: { source: 'plain-input' } },
    })

    try {
      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler(assistantMessageEnd('Should not deliver.'))

      expect(temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
    } finally {
      temp.cleanup()
    }
  })

  test('logs and skips malformed events or store write failures', async () => {
    const temp = createTempInterfaceStore()
    const runStore = new InMemoryRunStore()
    const run = createInterfaceRun(runStore)
    const consoleError = mock(() => {})
    const originalConsoleError = console.error
    const originalEnqueue = temp.interfaceStore.deliveries.enqueue.bind(
      temp.interfaceStore.deliveries
    )

    try {
      console.error = consoleError as typeof console.error
      temp.interfaceStore.deliveries.enqueue = (() => {
        throw new Error('sqlite busy')
      }) as typeof temp.interfaceStore.deliveries.enqueue

      const capture = createInterfaceResponseCapture({
        interfaceStore: temp.interfaceStore,
        runStore,
        runId: run.runId,
      })

      await capture.handler({
        type: 'message_end',
        messageId: 'msg-bad',
        message: { role: 'assistant', content: { nope: true } as unknown as string },
      })
      await capture.handler(assistantMessageEnd('enqueue fails', 'msg-good'))

      expect(consoleError).toHaveBeenCalledTimes(2)
      expect(originalEnqueue).toBeDefined()
      expect(temp.interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toEqual([])
    } finally {
      temp.interfaceStore.deliveries.enqueue = originalEnqueue
      console.error = originalConsoleError
      temp.cleanup()
    }
  })
})
