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
})
