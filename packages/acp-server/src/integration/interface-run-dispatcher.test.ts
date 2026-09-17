import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from 'acp-interface-store'

import { InMemoryRunStore } from '../domain/run-store.js'
import type { StoredRun } from '../domain/run-store.js'
import { readCompletedAssistantMessageAfterSeq } from '../real-launcher.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

type ActivityModule = typeof dispatcherModule & {
  lastObservedActivityMs?: (run: StoredRun, hrcDbPath: string) => number
}

type SqlStatementFactory = (this: Database, sql: string) => object

function patchSchemaDetection(inject: () => void): {
  injected: () => boolean
  restore: () => void
} {
  const prototype = Database.prototype as unknown as {
    query: SqlStatementFactory
    prepare: SqlStatementFactory
  }
  const originalQuery = prototype.query
  const originalPrepare = prototype.prepare
  let didInject = false

  const wrapStatement = (statement: object, sql: string): object => {
    if (!/table_info/i.test(sql)) return statement
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (
          (property === 'all' || property === 'get' || property === 'values') &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, target, args)
            if (!didInject) {
              inject()
              didInject = true
            }
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  prototype.query = function query(sql: string): object {
    return wrapStatement(originalQuery.call(this, sql), sql)
  }
  prototype.prepare = function prepare(sql: string): object {
    return wrapStatement(originalPrepare.call(this, sql), sql)
  }

  return {
    injected: () => didInject,
    restore: () => {
      prototype.query = originalQuery
      prototype.prepare = originalPrepare
    },
  }
}

const fixtureDirs: string[] = []

afterEach(() => {
  while (fixtureDirs.length > 0) {
    const dir = fixtureDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('interface run dispatcher stale activity window', () => {
  test('finalizes a federated interface run from HRC durable message correlation', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
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
      hrcDbPath: hrc.hrcDbPath,
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
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
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
      hrcDbPath: hrc.hrcDbPath,
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

  test('preserves the typed dead-letter cause for a plain federated-message run', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
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
      hrcDbPath: hrc.hrcDbPath,
      hrcClient: {
        waitMessage: async () =>
          ({
            matched: false as const,
            reason: 'delivery_failed' as const,
            messageId: 'msg-t4-failed-request',
            errorCode: 'peer_delivery_failed',
            errorMessage: 'max3 rejected the envelope',
            errorReason: 'routed-elsewhere',
            retryable: false,
            homeNodeId: 'max3',
          }) as any,
      },
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(runStore.getRun(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'stale_context',
      errorMessage: 'max3 rejected the envelope',
      metadata: {
        meta: {
          hrcSemanticMessage: {
            terminal: {
              state: 'failed',
              error: {
                code: 'stale_context',
                message: 'max3 rejected the envelope',
                reason: 'routed-elsewhere',
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

  test('times out a never-answered plain federated-message run', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
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
      hrcDbPath: hrc.hrcDbPath,
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
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
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
      hrcDbPath: hrc.hrcDbPath,
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

  test('finalizes a completed headless run even without an interface delivery source', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:taskboard:task:primary',
      laneRef: 'lane:ui-concierge' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        content: 'diagnostic only: reply exactly ACP-UI-CONCIERGE-LANE-DIAG',
      },
    })
    runStore.updateRun(run.runId, {
      hrcRunId: 'hrc-run-concierge',
      hostSessionId: 'hsid-concierge',
      generation: 1,
      runtimeId: 'rt-concierge',
      transport: 'headless',
    })
    insertRunStatus(hrc.db, {
      runId: 'hrc-run-concierge',
      hostSessionId: 'hsid-concierge',
      runtimeId: 'rt-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'completed',
    })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 11,
      hostSessionId: 'hsid-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      runId: 'hrc-run-concierge',
      text: 'ACP-UI-CONCIERGE-LANE-DIAG',
    })
    insertTurnCompleted(hrc.db, {
      hrcSeq: 12,
      hostSessionId: 'hsid-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      runId: 'hrc-run-concierge',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrcDbPath: hrc.hrcDbPath,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('immediately fails a bare terminated HRC run without stale-timeout reconciliation', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:taskboard:task:terminated',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
    })
    runStore.updateRun(run.runId, {
      hrcRunId: 'hrc-run-terminated',
      hostSessionId: 'hsid-terminated',
      generation: 1,
      runtimeId: 'rt-terminated',
      transport: 'headless',
    })
    insertRunStatus(hrc.db, {
      runId: 'hrc-run-terminated',
      hostSessionId: 'hsid-terminated',
      runtimeId: 'rt-terminated',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'terminated',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrcDbPath: hrc.hrcDbPath,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(runStore.getRun(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'turn_failed',
      errorMessage: 'HRC run hrc-run-terminated ended with status: terminated',
    })
    expect(runStore.getRun(run.runId)?.errorCode).not.toBe('turn_timeout')
    interfaceStore.close()
  })

  test('tmux runs do not finalize delivery on the first assistant message before turn completion', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:smokey:project:agent-spaces',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_live',
            conversationRef: 'channel:chan_live',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
        },
      },
    })
    runStore.updateRun(run.runId, {
      hostSessionId: 'hsid-live',
      generation: 7,
      runtimeId: 'rt-live',
      transport: 'tmux',
      afterHrcSeq: 10,
    })

    insertAssistantMessage(hrc.db, {
      hrcSeq: 11,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
      text: 'first message, not final',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrcDbPath: hrc.hrcDbPath,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('running')

    insertAssistantMessage(hrc.db, {
      hrcSeq: 12,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
      text: 'final message',
    })
    insertTurnCompleted(hrc.db, {
      hrcSeq: 13,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
    })

    await dispatcher.runOnce()

    const [delivery] = interfaceStore.deliveries.listQueuedForGateway('discord_prod')
    expect(delivery).toMatchObject({
      runId: run.runId,
      bodyText: 'final message',
    })
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('tmux follow-up ignores a previous run completion after the dispatch fence', async () => {
    const hrc = createHrcDb()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-dispatch-'))
    fixtureDirs.push(fixtureDir)
    const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:smokey:project:agent-spaces',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_live',
            conversationRef: 'channel:chan_live',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
        },
      },
    })
    runStore.updateRun(run.runId, {
      hostSessionId: 'hsid-live',
      generation: 7,
      runtimeId: 'rt-live',
      transport: 'tmux',
      afterHrcSeq: 20,
    })

    insertTurnCompleted(hrc.db, {
      hrcSeq: 21,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-previous',
    })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 22,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-follow-up',
      text: 'follow-up still running',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrcDbPath: hrc.hrcDbPath,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('running')

    insertTurnCompleted(hrc.db, {
      hrcSeq: 23,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-follow-up',
    })

    await dispatcher.runOnce()

    const [delivery] = interfaceStore.deliveries.listQueuedForGateway('discord_prod')
    expect(delivery).toMatchObject({
      runId: run.runId,
      bodyText: 'follow-up still running',
    })
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('uses recent hrc_events activity to keep an old running run from going stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-active',
      hostSessionId: 'hsid-active',
      generation: 4,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 9 * 60_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })
    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(false)
  })

  test('treats an old running run with no correlated hrc_events activity as stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-missing',
      hostSessionId: 'hsid-missing',
      generation: 7,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: 'other-hrc-run',
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(true)
  })

  test('treats an old running run with only old hrc_events activity as stale', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-idle',
      hostSessionId: 'hsid-idle',
      generation: 2,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 15 * 60_000),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 600_000)).toBe(true)
  })

  test('does not slide pending dispatch timeout for runs without hrcRunId', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'pending',
      updatedAt: isoAgo(now, 12 * 60_000),
      hostSessionId: 'hsid-pending',
      generation: 5,
    })

    insertHrcEvent(hrc.db, {
      ts: isoAgo(now, 10_000),
      runId: 'hrc-run-not-yet-correlated',
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 45_000)).toBe(true)
  })

  test('clamps future hrc_events timestamps to now before stale math', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-future',
      hostSessionId: 'hsid-future',
      generation: 9,
    })

    insertHrcEvent(hrc.db, {
      ts: new Date(now + 5 * 60_000).toISOString(),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    const before = Date.now()
    const observed = lastObservedActivityMs(run, hrc.hrcDbPath)
    const after = Date.now()

    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
    expect(after - observed > 600_000).toBe(false)
  })
})

function isStaleFromLastObservedActivity(
  run: StoredRun,
  hrcDbPath: string,
  staleTimeoutMs: number
): boolean {
  return Date.now() - lastObservedActivityMs(run, hrcDbPath) > staleTimeoutMs
}

function lastObservedActivityMs(run: StoredRun, hrcDbPath: string): number {
  const helper = (dispatcherModule as ActivityModule).lastObservedActivityMs
  if (typeof helper !== 'function') {
    throw new Error(
      'Expected interface-run-dispatcher to export lastObservedActivityMs(run, hrcDbPath)'
    )
  }
  return helper(run, hrcDbPath)
}

function createHrcDb(): { db: Database; hrcDbPath: string } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-stale-'))
  fixtureDirs.push(fixtureDir)
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      runtime_id TEXT,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      operation_id TEXT,
      invocation_id TEXT,
      dispatched_input_id TEXT
    );

    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_seq INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      runtime_id TEXT,
      run_id TEXT,
      launch_id TEXT,
      app_id TEXT,
      app_session_key TEXT,
      category TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      transport TEXT,
      error_code TEXT,
      replayed INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL
    );
  `)
  return { db, hrcDbPath }
}

function insertRunStatus(
  db: Database,
  input: {
    runId: string
    hostSessionId: string
    runtimeId?: string | undefined
    scopeRef: string
    laneRef: string
    generation: number
    transport: string
    status: string
    errorCode?: string | undefined
    errorMessage?: string | undefined
  }
): void {
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO runs (
      run_id,
      host_session_id,
      runtime_id,
      scope_ref,
      lane_ref,
      generation,
      transport,
      status,
      accepted_at,
      started_at,
      completed_at,
      updated_at,
      error_code,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.runId,
    input.hostSessionId,
    input.runtimeId ?? null,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.transport,
    input.status,
    now,
    now,
    input.status === 'completed' ||
      input.status === 'failed' ||
      input.status === 'cancelled' ||
      input.status === 'terminated'
      ? now
      : null,
    now,
    input.errorCode ?? null,
    input.errorMessage ?? null
  )
}

function insertHrcEvent(
  db: Database,
  input: {
    ts: string
    runId: string | undefined
    hostSessionId: string | undefined
    scopeRef: string
    laneRef: string
    generation: number | undefined
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      stream_seq,
      ts,
      host_session_id,
      scope_ref,
      lane_ref,
      generation,
      run_id,
      category,
      event_kind,
      payload_json
    ) VALUES (
      (SELECT COALESCE(MAX(stream_seq), 0) + 1 FROM hrc_events),
      ?, ?, ?, ?, ?, ?, 'turn', 'turn.message', ?
    )`,
    input.ts,
    input.hostSessionId ?? 'hsid-default',
    input.scopeRef,
    input.laneRef,
    input.generation ?? 0,
    input.runId ?? null,
    JSON.stringify({ type: 'turn_delta', text: 'progress' })
  )
}

function insertAssistantMessage(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
    text: string
  }
): void {
  insertSessionEvent(db, {
    ...input,
    eventKind: 'turn.message',
    payload: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: input.text }],
      },
    },
  })
}

function insertTurnCompleted(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
  }
): void {
  insertSessionEvent(db, {
    ...input,
    eventKind: 'turn.completed',
    payload: {
      success: true,
      transport: 'tmux',
    },
  })
}

function insertSessionEvent(
  db: Database,
  input: {
    hrcSeq: number
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId: string
    eventKind: string
    payload: Record<string, unknown>
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq,
      stream_seq,
      ts,
      host_session_id,
      scope_ref,
      lane_ref,
      generation,
      run_id,
      category,
      event_kind,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?)`,
    input.hrcSeq,
    input.hrcSeq,
    new Date().toISOString(),
    input.hostSessionId,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.runId,
    input.eventKind,
    JSON.stringify(input.payload)
  )
}

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  const now = new Date().toISOString()
  return {
    runId: 'acp-run-1',
    scopeRef: 'agent:smokey:project:agent-spaces',
    laneRef: 'main',
    actor: { kind: 'user', id: 'discord:user:1' },
    status: 'running',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function isoAgo(now: number, ageMs: number): string {
  return new Date(now - ageMs).toISOString()
}

type EvidenceOrigin = 'retained' | null

function createEvidenceHrcDb(): { db: Database; hrcDbPath: string } {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-retained-'))
  fixtureDirs.push(fixtureDir)
  const hrcDbPath = join(fixtureDir, 'hrc.sqlite')
  const db = new Database(hrcDbPath)
  db.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      host_session_id TEXT NOT NULL,
      runtime_id TEXT,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      operation_id TEXT,
      invocation_id TEXT,
      dispatched_input_id TEXT
    );
    CREATE TABLE hrc_events (
      hrc_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_seq INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      host_session_id TEXT NOT NULL,
      scope_ref TEXT NOT NULL,
      lane_ref TEXT NOT NULL,
      generation INTEGER NOT NULL,
      runtime_id TEXT,
      run_id TEXT,
      launch_id TEXT,
      app_id TEXT,
      app_session_key TEXT,
      category TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      transport TEXT,
      error_code TEXT,
      replayed INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')
    );
  `)
  return { db, hrcDbPath }
}

function insertEvidenceEvent(
  db: Database,
  input: {
    hrcSeq: number
    ts?: string | undefined
    hostSessionId: string
    scopeRef: string
    laneRef: string
    generation: number
    runId?: string | undefined
    eventKind: string
    payload: Record<string, unknown>
    evidenceOrigin: EvidenceOrigin
    replayed?: boolean | undefined
  }
): void {
  db.run(
    `INSERT INTO hrc_events (
      hrc_seq, stream_seq, ts, host_session_id, scope_ref, lane_ref, generation,
      run_id, category, event_kind, replayed, payload_json, evidence_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'turn', ?, ?, ?, ?)`,
    input.hrcSeq,
    input.hrcSeq,
    input.ts ?? new Date().toISOString(),
    input.hostSessionId,
    input.scopeRef,
    input.laneRef,
    input.generation,
    input.runId ?? null,
    input.eventKind,
    input.replayed === true ? 1 : 0,
    JSON.stringify(input.payload),
    input.evidenceOrigin
  )
}

function assistantPayload(text: string): Record<string, unknown> {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function createTmuxActuationFixture(input: {
  hrcDbPath: string
  runStore?: InMemoryRunStore | undefined
  generation?: number | undefined
  hrcRunId?: string | undefined
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'acp-interface-retained-store-'))
  fixtureDirs.push(fixtureDir)
  const interfaceStore = openInterfaceStore({ dbPath: join(fixtureDir, 'interface.sqlite') })
  const runStore = input.runStore ?? new InMemoryRunStore()
  const sessionRef = {
    scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
    laneRef: 'main' as const,
  }
  const run = runStore.createRun({
    sessionRef,
    status: 'running',
    metadata: {
      meta: {
        interfaceSource: {
          gatewayId: 'discord_prod',
          bindingId: 'ifb_retained',
          conversationRef: 'channel:retained',
          messageRef: 'discord:message:prompt',
          replyToMessageRef: 'discord:message:prompt',
        },
      },
    },
  })
  runStore.updateRun(run.runId, {
    hostSessionId: 'hsid-retained',
    runtimeId: 'rt-retained',
    transport: input.hrcRunId === undefined ? 'tmux' : 'headless',
    afterHrcSeq: 10,
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ...(input.hrcRunId !== undefined ? { hrcRunId: input.hrcRunId } : {}),
  })
  const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
    runStore,
    interfaceStore,
    hrcDbPath: input.hrcDbPath,
    config: { intervalMs: 1, staleTimeoutMs: 10 },
  })
  return { dispatcher, interfaceStore, runStore, run, sessionRef }
}

function insertCompletedPair(
  db: Database,
  input: {
    firstSeq: number
    text: string
    runId: string
    evidenceOrigin: EvidenceOrigin
    replayed?: boolean | undefined
    ts?: string | undefined
  }
): void {
  const common = {
    hostSessionId: 'hsid-retained',
    scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
    laneRef: 'main',
    generation: 7,
    runId: input.runId,
    evidenceOrigin: input.evidenceOrigin,
    replayed: input.replayed,
    ts: input.ts,
  }
  insertEvidenceEvent(db, {
    ...common,
    hrcSeq: input.firstSeq,
    eventKind: 'turn.message',
    payload: assistantPayload(input.text),
  })
  insertEvidenceEvent(db, {
    ...common,
    hrcSeq: input.firstSeq + 1,
    eventKind: 'turn.completed',
    payload: { success: true, transport: 'tmux' },
  })
}

// T-08575: present-origin HRC history remains queryable but cannot actuate a
// current interface run; ordinary and replayed controls preserve today's path.
describe('T-08575 retained-evidence actuation fence', () => {
  test('T1 retained completion cannot finalize or enqueue delivery', async () => {
    const hrc = createEvidenceHrcDb()
    const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation: 7 })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
      ts: isoAgo(Date.now(), 2 * 60 * 60_000),
    })

    await fx.dispatcher.runOnce()

    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)
    expect(JSON.stringify(fx.runStore.getRun(fx.run.runId)?.metadata)).not.toContain(
      'deliveryRequestId'
    )
    expect(hrc.db.query('SELECT hrc_seq FROM hrc_events').all()).toHaveLength(2)
    fx.interfaceStore.close()
    hrc.db.close()
  })

  for (const control of [
    { id: 'C', replayed: false },
    { id: "C'", replayed: true },
  ]) {
    test(`T1 ${control.id} ordinary-origin completion still finalizes and delivers`, async () => {
      const hrc = createEvidenceHrcDb()
      const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation: 7 })
      insertCompletedPair(hrc.db, {
        firstSeq: 11,
        text: 'OLD-REPLY',
        runId: 'run-control',
        evidenceOrigin: null,
        replayed: control.replayed,
      })

      await fx.dispatcher.runOnce()

      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
        { bodyText: 'OLD-REPLY' },
      ])
      fx.interfaceStore.close()
      hrc.db.close()
    })
  }

  test('T1b a live completion after retained history finalizes exactly once with live text', async () => {
    const hrc = createEvidenceHrcDb()
    const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation: 7 })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
    })
    insertCompletedPair(hrc.db, {
      firstSeq: 13,
      text: 'NEW-REPLY',
      runId: 'run-live',
      evidenceOrigin: null,
    })

    await fx.dispatcher.runOnce()

    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
      { bodyText: 'NEW-REPLY' },
    ])
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(1)
    fx.interfaceStore.close()
    hrc.db.close()
  })

  for (const generation of [undefined, 7] as const) {
    test(`T4 retained old activity cannot regress live activity (${generation === undefined ? 'without' : 'with'} generation)`, async () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: generation ?? 0,
        runId: 'run-live',
        eventKind: 'turn.tool_call',
        payload: { tool: 'live' },
        evidenceOrigin: null,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 12,
        ts: isoAgo(now, 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: generation ?? 0,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: { tool: 'retained' },
        evidenceOrigin: 'retained',
      })

      expect(lastObservedActivityMs(run, hrc.hrcDbPath)).toBeGreaterThanOrEqual(now - 1_000)
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
      hrc.db.close()
    })

    test(`T4 C ordinary old activity remains the latest actuator (${generation === undefined ? 'without' : 'with'} generation)`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation,
        afterHrcSeq: 10,
      })
      for (const [hrcSeq, ts] of [
        [11, new Date(now).toISOString()],
        [12, isoAgo(now, 2 * 60 * 60_000)],
      ] as const) {
        insertEvidenceEvent(hrc.db, {
          hrcSeq,
          ts,
          hostSessionId: 'hsid-retained',
          scopeRef: run.scopeRef,
          laneRef: run.laneRef,
          generation: generation ?? 0,
          runId: `run-${hrcSeq}`,
          eventKind: 'turn.tool_call',
          payload: {},
          evidenceOrigin: null,
        })
      }
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
      hrc.db.close()
    })
  }

  test('T4b retained old activity is fenced on the own-hrcRunId activity branch', () => {
    const now = Date.now()
    const hrc = createEvidenceHrcDb()
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hrcRunId: 'run-live',
      hostSessionId: 'hsid-retained',
      generation: 7,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 11,
      ts: new Date(now).toISOString(),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 12,
      ts: isoAgo(now, 2 * 60 * 60_000),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: 'retained',
    })
    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
    hrc.db.close()
  })

  test('T4b C ordinary old activity still makes the own-run branch stale', () => {
    const now = Date.now()
    const hrc = createEvidenceHrcDb()
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hrcRunId: 'run-live',
      hostSessionId: 'hsid-retained',
      generation: 7,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 11,
      ts: new Date(now).toISOString(),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 12,
      ts: isoAgo(now, 2 * 60 * 60_000),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
    hrc.db.close()
  })

  for (const branch of ['without-generation', 'with-generation', 'own-run'] as const) {
    test(`T4c fresh retained audit activity cannot delay timeout (${branch})`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation: branch === 'without-generation' ? undefined : 7,
        hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: branch === 'without-generation' ? 0 : 7,
        runId: branch === 'own-run' ? 'run-live' : 'run-recovered',
        eventKind: 'runtime.interrupted',
        payload: { reason: 'retained-audit' },
        evidenceOrigin: 'retained',
      })
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
      hrc.db.close()
    })

    test(`T4c C fresh ordinary activity still delays timeout (${branch})`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation: branch === 'without-generation' ? undefined : 7,
        hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: branch === 'without-generation' ? 0 : 7,
        runId: branch === 'own-run' ? 'run-live' : 'run-ordinary',
        eventKind: 'runtime.interrupted',
        payload: {},
        evidenceOrigin: null,
      })
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
      hrc.db.close()
    })
  }

  for (const generation of [undefined, 7] as const) {
    test(`T4 runOnce does not emit turn_timeout from retained old activity (${generation === undefined ? 'without' : 'with'} generation)`, async () => {
      const hrc = createEvidenceHrcDb()
      const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation })
      await Bun.sleep(20)
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        hostSessionId: 'hsid-retained',
        scopeRef: fx.sessionRef.scopeRef,
        laneRef: fx.sessionRef.laneRef,
        generation: generation ?? 0,
        runId: 'run-live',
        eventKind: 'turn.tool_call',
        payload: {},
        evidenceOrigin: null,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 12,
        ts: isoAgo(Date.now(), 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: fx.sessionRef.scopeRef,
        laneRef: fx.sessionRef.laneRef,
        generation: generation ?? 0,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: {},
        evidenceOrigin: 'retained',
      })

      await fx.dispatcher.runOnce()

      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.runStore.getRun(fx.run.runId)?.errorCode).not.toBe('turn_timeout')
      fx.interfaceStore.close()
      hrc.db.close()
    })
  }

  for (const branch of ['without-generation', 'with-generation', 'own-run'] as const) {
    for (const control of [
      { id: 'retained', origin: 'retained' as const, expectedStatus: 'failed' },
      { id: 'C', origin: null, expectedStatus: 'running' },
    ]) {
      test(`T4c runOnce ${control.id} fresh activity (${branch})`, async () => {
        const hrc = createEvidenceHrcDb()
        const fx = createTmuxActuationFixture({
          hrcDbPath: hrc.hrcDbPath,
          generation: branch === 'without-generation' ? undefined : 7,
          hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
        })
        await Bun.sleep(20)
        insertEvidenceEvent(hrc.db, {
          hrcSeq: 11,
          hostSessionId: 'hsid-retained',
          scopeRef: fx.sessionRef.scopeRef,
          laneRef: fx.sessionRef.laneRef,
          generation: branch === 'without-generation' ? 0 : 7,
          runId: branch === 'own-run' ? 'run-live' : 'run-recovered',
          eventKind: 'runtime.interrupted',
          payload: {},
          evidenceOrigin: control.origin,
        })

        await fx.dispatcher.runOnce()

        expect(fx.runStore.getRun(fx.run.runId)?.status).toBe(control.expectedStatus)
        if (control.expectedStatus === 'failed') {
          expect(fx.runStore.getRun(fx.run.runId)?.errorCode).toBe('turn_timeout')
        }
        fx.interfaceStore.close()
        hrc.db.close()
      })
    }
  }

  test('T-TX3 dispatcher finalize detects and selects from one production read transaction', async () => {
    const hrc = createHrcDb()
    hrc.db.exec('PRAGMA journal_mode = WAL')
    const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation: 7 })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 5,
      hostSessionId: 'hsid-retained',
      scopeRef: fx.sessionRef.scopeRef,
      laneRef: fx.sessionRef.laneRef,
      generation: 7,
      runId: 'run-live',
      text: 'LIVE-BASELINE',
    })
    const writer = new Database(hrc.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const detectionPatch = patchSchemaDetection(() => {
      writer.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
      )
      insertCompletedPair(writer, {
        firstSeq: 11,
        text: 'OLD-REPLY',
        runId: 'run-hist',
        evidenceOrigin: 'retained',
      })
    })

    try {
      await fx.dispatcher.runOnce()
      expect(detectionPatch.injected()).toBe(true)
      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)

      await fx.dispatcher.runOnce()
      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)
    } finally {
      detectionPatch.restore()
      writer.close()
      fx.interfaceStore.close()
      hrc.db.close()
    }
  })

  test('T-TX4 activity read detects and selects from one production read transaction', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    hrc.db.exec('PRAGMA journal_mode = WAL')
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hostSessionId: 'hsid-retained',
      generation: 7,
      afterHrcSeq: 10,
    })
    insertSessionEvent(hrc.db, {
      hrcSeq: 10,
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: { tool: 'live' },
    })
    const writer = new Database(hrc.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const detectionPatch = patchSchemaDetection(() => {
      writer.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
      )
      insertEvidenceEvent(writer, {
        hrcSeq: 11,
        ts: isoAgo(now, 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: 7,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: { tool: 'retained' },
        evidenceOrigin: 'retained',
      })
    })

    try {
      const observed = lastObservedActivityMs(run, hrc.hrcDbPath)
      expect(detectionPatch.injected()).toBe(true)
      expect(observed).toBeGreaterThanOrEqual(now - 1_000)

      expect(lastObservedActivityMs(run, hrc.hrcDbPath)).toBeGreaterThanOrEqual(now - 1_000)
    } finally {
      detectionPatch.restore()
      writer.close()
      hrc.db.close()
    }
  })

  test('K1 own terminal run may finalize from its retained final output', async () => {
    const hrc = createEvidenceHrcDb()
    const fx = createTmuxActuationFixture({
      hrcDbPath: hrc.hrcDbPath,
      generation: 7,
      hrcRunId: 'run-own',
    })
    insertRunStatus(hrc.db, {
      runId: 'run-own',
      hostSessionId: 'hsid-retained',
      runtimeId: 'rt-retained',
      scopeRef: fx.sessionRef.scopeRef,
      laneRef: fx.sessionRef.laneRef,
      generation: 7,
      transport: 'headless',
      status: 'completed',
    })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'RECOVERED-OWN-OUTPUT',
      runId: 'run-own',
      evidenceOrigin: 'retained',
    })

    await fx.dispatcher.runOnce()

    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
      { bodyText: 'RECOVERED-OWN-OUTPUT' },
    ])
    fx.interfaceStore.close()
    hrc.db.close()
  })

  test('U-up observes old-to-new schema upgrade without recreating the dispatcher', async () => {
    const hrc = createHrcDb()
    const fx = createTmuxActuationFixture({ hrcDbPath: hrc.hrcDbPath, generation: 7 })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')

    hrc.db.exec(
      "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
    )
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
    })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')

    insertCompletedPair(hrc.db, {
      firstSeq: 13,
      text: 'NEW-REPLY',
      runId: 'run-live',
      evidenceOrigin: null,
    })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
      { bodyText: 'NEW-REPLY' },
    ])
    fx.interfaceStore.close()
    hrc.db.close()
  })

  test('U-err S3 reader surfaces a missing hrc_events table', () => {
    const hrc = createEvidenceHrcDb()
    hrc.db.exec('ALTER TABLE hrc_events RENAME TO hrc_events_removed')
    expect(() =>
      readCompletedAssistantMessageAfterSeq({
        hrcDbPath: hrc.hrcDbPath,
        hostSessionId: 'hsid-retained',
        sessionRef: {
          scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
          laneRef: 'main',
        },
        afterHrcSeq: 10,
      })
    ).toThrow()
    hrc.db.close()
  })

  test('U-err S4 preserves fallback to run.updatedAt when hrc_events disappears', () => {
    const now = Date.now()
    const hrc = createEvidenceHrcDb()
    const run = makeRun({
      updatedAt: new Date(now).toISOString(),
      hostSessionId: 'hsid-retained',
      generation: 7,
      afterHrcSeq: 10,
    })
    hrc.db.exec('ALTER TABLE hrc_events RENAME TO hrc_events_removed')
    expect(lastObservedActivityMs(run, hrc.hrcDbPath)).toBe(Date.parse(run.updatedAt))
    hrc.db.close()
  })
})
