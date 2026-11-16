import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { createInMemoryWorkflowKernel } from 'acp-core'

import { openAcpStateStore } from '../src/index.js'

const now = '2026-05-11T12:00:00.000Z'

function snapshot() {
  const kernel = createInMemoryWorkflowKernel({ now })
  kernel.publishWorkflowDefinition({
    id: 'contract',
    version: 1,
    kind: 'test',
    initial: { status: 'open', phase: 'todo' },
    roles: {},
    evidenceKinds: {},
    transitions: {},
  })
  kernel.createTask({
    taskId: 'task-contract',
    projectId: 'demo',
    workflow: { id: 'contract', version: 1 },
    goal: 'Preserve repository contracts',
    roleBindings: {},
    idempotencyKey: 'create',
  })
  const result = kernel.exportSnapshot()
  result.effects = ['b', 'a'].map((suffix) => ({
    effectId: `effect-${suffix}`,
    taskId: 'task-contract',
    sourceEventId: result.events[0]!.eventId,
    kind: 'unknown-effect',
    payload: { z: [null, { y: 2, a: 1 }], a: true },
    idempotencyKey: `intent-${suffix}`,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
  }))
  result.contextHashes = [{ taskId: 'task-contract', hashes: ['hash-z', 'hash-a'] }]
  return result
}

// Independent canonicalization pins the persisted hash contract, rather than
// testing the implementation against its own serializer.
function hash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item === null || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    )
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`
}

describe('workflow runtime repository contracts', () => {
  test('replacement orders rows, preserves replay state, and rolls back a failed write', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const input = snapshot()
      store.workflowRuntime.saveSnapshot(input)
      const baseline = store.workflowRuntime.loadSnapshot()
      expect(baseline.effects.map((effect) => effect.effectId)).toEqual(['effect-a', 'effect-b'])
      expect(baseline.contextHashes).toEqual([
        { taskId: 'task-contract', hashes: ['hash-a', 'hash-z'] },
      ])
      expect(baseline.idempotency).toEqual(input.idempotency)
      expect(baseline.sequence).toBe(input.sequence)
      expect(baseline.tasks).toEqual(input.tasks)
      expect(baseline.events).toEqual(input.events)

      expect(() =>
        store.workflowRuntime.saveSnapshot({ ...input, tasks: [...input.tasks, ...input.tasks] })
      ).toThrow()
      expect(store.workflowRuntime.loadSnapshot()).toEqual(baseline)

      store.workflowRuntime.saveSnapshot({ ...input, effects: [], contextHashes: [], sequence: 0 })
      expect(store.workflowRuntime.loadSnapshot()).toMatchObject({
        effects: [],
        contextHashes: [],
        sequence: 0,
      })
    } finally {
      store.close()
    }
  })

  test.each(['Delivered', 'Failed', 'Unsupported'] as const)(
    'effect %s preserves lease guards, terminal idempotency, source linkage and hashes',
    (terminal) => {
      const store = openAcpStateStore({ dbPath: ':memory:' })
      try {
        const repo = store.workflowRuntime
        const input = snapshot()
        repo.saveSnapshot(input)
        expect(repo.listPendingEffectIntents(1).map((effect) => effect.effectId)).toEqual([
          'effect-a',
        ])
        const leased = repo.leaseEffectIntent('effect-a')
        expect(leased).toEqual({
          ...input.effects[1],
          state: 'leased',
          updatedAt: expect.any(String),
        })
        expect(repo.leaseEffectIntent('effect-a')).toBeUndefined()
        repo[`markEffectIntent${terminal}`]('effect-a')
        repo[`markEffectIntent${terminal}`]('effect-a')
        repo[`markEffectIntent${terminal}`]('missing')
        const loaded = repo.loadSnapshot()
        expect(loaded.effects[0]?.state).toBe(terminal.toLowerCase())
        expect(loaded.events).toHaveLength(3)
        const source = input.events[0]!
        for (const [index, event] of loaded.events.slice(1).entries()) {
          const { eventHash, ...unhashed } = event
          expect(event).toMatchObject({
            workflowSeq: index + 2,
            prevHash: source.eventHash,
            causationId: source.eventId,
            actor: source.actor,
            observedTaskVersion: source.nextTaskVersion ?? source.observedTaskVersion,
            idempotencyKey: `intent-a:${event.type}`,
            result: 'recorded',
          })
          expect(eventHash).toBe(hash(unhashed))
          expect(event.commandHash).toBe(
            hash({
              type: event.type,
              effectId: 'effect-a',
              payload: event.payload,
            })
          )
        }
        if (terminal === 'Unsupported') {
          expect(loaded.events[2]?.payload).toMatchObject({
            errorCode: 'unsupported_effect',
            errorMessage: 'Unsupported workflow effect kind: unknown-effect',
          })
        }
      } finally {
        store.close()
      }
    }
  )
})
