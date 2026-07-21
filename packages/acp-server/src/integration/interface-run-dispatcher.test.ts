import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openInterfaceStore } from 'acp-interface-store'

import { InMemoryRunStore } from '../domain/run-store.js'
import type { StoredRun } from '../domain/run-store.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

type ActivityModule = typeof dispatcherModule & {
  lastObservedActivityMs?: (run: StoredRun, hrcDbPath: string) => number
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
      errorCode: 'peer_delivery_failed',
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
