import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'

describe('acp-state-store smoke', () => {
  test('constructs an in-memory store and persists actor-stamped records', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })

    const createdRun = store.runs.createRun({
      sessionRef: { scopeRef: 'agent:smokey:project:test', laneRef: 'main' },
      actor: { kind: 'system', id: 'acp-local' },
    })

    const createdAttempt = store.inputAttempts.createAttempt({
      sessionRef: { scopeRef: 'agent:smokey:project:test', laneRef: 'main' },
      idempotencyKey: 'smoke-key',
      content: 'hello',
      actor: { kind: 'system', id: 'acp-local' },
      runStore: store.runs,
    })

    const outboxRecord = store.transitionOutbox.append({
      transitionEventId: 'evt_smoke',
      taskId: 'T-smoke',
      projectId: 'project-test',
      fromPhase: 'ready',
      toPhase: 'done',
      actor: { kind: 'system', id: 'acp-local' },
      payload: { ok: true },
      createdAt: '2026-04-23T00:00:02.000Z',
    })

    expect(createdRun.actor).toEqual({ kind: 'system', id: 'acp-local' })
    expect(createdAttempt.inputAttempt.actor).toEqual({ kind: 'system', id: 'acp-local' })
    expect(outboxRecord.actor).toEqual({ kind: 'system', id: 'acp-local' })

    store.close()
  })

  test('listDispatchableSessionHeads returns one queued head per session over real SQLite', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })

    function enqueue(
      scopeRef: string,
      laneRef: string,
      seq: number,
      status: 'queued' | 'leased' | 'dispatching' = 'queued'
    ): string {
      const sessionRef = { scopeRef, laneRef }
      const run = store.runs.createRun({
        sessionRef,
        actor: { kind: 'system', id: 'acp-local' },
      })
      const attempt = store.inputAttempts.createAttempt({
        sessionRef,
        idempotencyKey: `${scopeRef}-${laneRef}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
        content: `q-${seq}`,
        actor: { kind: 'system', id: 'acp-local' },
        runStore: store.runs,
      })
      const item = store.inputQueue.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        scopeRef,
        laneRef,
        seq,
        status,
        resetPolicy: 'follow_latest',
      })
      return item.queueItemId
    }

    // Session A: seq 1 (queued, head), seq 2 (queued, behind)
    enqueue('agent:alpha:project:test', 'main', 1, 'queued')
    enqueue('agent:alpha:project:test', 'main', 2, 'queued')
    // Session B: seq 1 (dispatching, NOT a queued head), seq 2 (queued, head among queued)
    enqueue('agent:beta:project:test', 'main', 1, 'dispatching')
    const betaSeq2 = enqueue('agent:beta:project:test', 'main', 2, 'queued')
    // Session C: seq 1 (queued, head)
    enqueue('agent:gamma:project:test', 'main', 1, 'queued')
    // Session D: only leased item — should not appear in dispatchable session heads
    enqueue('agent:delta:project:test', 'main', 1, 'leased')

    const heads = store.inputQueue.listDispatchableSessionHeads()
    const headsByScope = new Map(heads.map((h) => [h.scopeRef, h]))

    expect(heads).toHaveLength(3)
    expect(headsByScope.get('agent:alpha:project:test')?.seq).toBe(1)
    expect(headsByScope.get('agent:beta:project:test')?.queueItemId).toBe(betaSeq2)
    expect(headsByScope.get('agent:beta:project:test')?.seq).toBe(2)
    expect(headsByScope.get('agent:gamma:project:test')?.seq).toBe(1)
    expect(headsByScope.has('agent:delta:project:test')).toBe(false)

    store.close()
  })

  test('listDispatchableSessionHeads scales past the legacy 50-item page cap', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })

    for (let i = 0; i < 75; i++) {
      const scopeRef = `agent:bulk-${i.toString().padStart(3, '0')}:project:test`
      const sessionRef = { scopeRef, laneRef: 'main' }
      const run = store.runs.createRun({
        sessionRef,
        actor: { kind: 'system', id: 'acp-local' },
      })
      const attempt = store.inputAttempts.createAttempt({
        sessionRef,
        idempotencyKey: `${scopeRef}-bulk-${i}`,
        content: `bulk ${i}`,
        actor: { kind: 'system', id: 'acp-local' },
        runStore: store.runs,
      })
      store.inputQueue.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        scopeRef,
        laneRef: 'main',
        seq: 1,
        status: 'queued',
        resetPolicy: 'follow_latest',
      })
    }

    const heads = store.inputQueue.listDispatchableSessionHeads()
    expect(heads).toHaveLength(75)
    const distinctScopes = new Set(heads.map((h) => h.scopeRef))
    expect(distinctScopes.size).toBe(75)

    store.close()
  })
})
