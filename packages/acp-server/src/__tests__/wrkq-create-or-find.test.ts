/**
 * T-04943 Phase B — RED tests: idempotent wrkq create-or-find port.
 *
 * Covers daedalus required test #3:
 *   - find-by-deterministic-key BEFORE create; repeated calls AND a crash-style
 *     retry recover the SAME task id; never a second task.
 *   - Key = project `agent-control-plane` + deterministic path from accepted incident.
 *   - current wrkq-lib taskStore.createTask synthesizes unique titles and is NOT
 *     create-or-find — this port adds the idempotent contract.
 *
 * All tests are RED until Phase B execution ships — createOrFindWrkqTask is a
 * stub that throws "not implemented".
 *
 * Uses a plain-object fake WorkClient (no subprocess, no real wrkq binary).
 * The fake maintains an in-memory task store keyed by path.
 */

import { describe, expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'
import { createOrFindWrkqTask } from 'wrkq-lib'
import type { WrkqTaskCreateOrFindInput } from 'wrkq-lib'

// ─── Fake WorkClient ──────────────────────────────────────────────────────────

type FakeTask = {
  uuid: string
  id: string
  slug: string
  path: string
  title: string
  description: string
  specification: string
  projectUuid: string
  state: string
  priority: number
  kind: string
  labels: string[]
  meta: Record<string, unknown>
  etag: number
  createdAt: string
  updatedAt: string
  completedAt: undefined
  archivedAt: undefined
  deletedAt: undefined
  acknowledgedAt: undefined
}

type FakeStore = {
  tasks: Map<string, FakeTask>    // keyed by path
  createCount: number
  listCount: number
  containerShowCount: number
}

function makeFakeWorkClient(fakeStore: FakeStore): WorkClient {
  const nextId = () => `T-${String(fakeStore.tasks.size + 1).padStart(5, '0')}`
  const containerProjectId = 'P-00001'

  return {
    wrkq: {
      task: {
        list: async (params: { path?: string } = {}) => {
          fakeStore.listCount += 1
          const items = params.path !== undefined
            ? [...fakeStore.tasks.values()].filter((t) => t.path === params.path)
            : [...fakeStore.tasks.values()]
          return { items, nextCursor: undefined }
        },
        create: async (params: { path?: string; project?: string; title: string; description?: string; idempotencyKey?: string }) => {
          fakeStore.createCount += 1
          // Idempotency key dedup: if a task with same path already exists, return it
          // (simulates what real wrkq would do with idempotencyKey)
          if (params.path !== undefined && fakeStore.tasks.has(params.path)) {
            return fakeStore.tasks.get(params.path) as FakeTask
          }
          const id = nextId()
          const slug = (params.path ?? id).split('/').pop() ?? id
          const path = params.path ?? `inbox/${slug}`
          const task: FakeTask = {
            uuid: `uuid-${id}`,
            id,
            slug,
            path,
            title: params.title,
            description: params.description ?? '',
            specification: '',
            projectUuid: containerProjectId,
            state: 'idea',
            priority: 3,
            kind: 'task',
            labels: [],
            meta: {},
            etag: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: undefined,
            archivedAt: undefined,
            deletedAt: undefined,
            acknowledgedAt: undefined,
          }
          fakeStore.tasks.set(path, task)
          return task
        },
        show: async (params: { task: string }) => {
          const found = [...fakeStore.tasks.values()].find((t) => t.id === params.task)
          if (!found) throw new Error(`task not found: ${params.task}`)
          return found
        },
        update: async () => { throw new Error('not used') },
        move: async () => { throw new Error('not used') },
        acknowledge: async () => { throw new Error('not used') },
        delete: async () => { throw new Error('not used') },
        restore: async () => { throw new Error('not used') },
      },
      container: {
        show: async () => {
          fakeStore.containerShowCount += 1
          return { id: containerProjectId, uuid: 'uuid-P00001', slug: 'agent-control-plane', path: 'agent-control-plane', createdAt: '', updatedAt: '' }
        },
        create: async () => { throw new Error('not used') },
        delete: async () => { throw new Error('not used') },
        deleteRecursive: async () => { throw new Error('not used') },
        list: async () => { throw new Error('not used') },
      },
      comment: { add: async () => { throw new Error('not used') }, list: async () => { throw new Error('not used') }, show: async () => { throw new Error('not used') }, delete: async () => { throw new Error('not used') } },
      attachment: { add: async () => { throw new Error('not used') }, list: async () => { throw new Error('not used') }, show: async () => { throw new Error('not used') }, remove: async () => { throw new Error('not used') } },
      relation: { add: async () => { throw new Error('not used') }, list: async () => { throw new Error('not used') }, remove: async () => { throw new Error('not used') } },
      workflow: { attach: async () => { throw new Error('not used') }, inspect: async () => { throw new Error('not used') }, timeline: async () => { throw new Error('not used') }, refresh: async () => { throw new Error('not used') } },
      admin: { legacyActor: { list: async () => { throw new Error('not used') }, create: async () => { throw new Error('not used') }, update: async () => { throw new Error('not used') } } },
    },
    wrkf: {} as WorkClient['wrkf'],
    rpc: {
      initialize: async () => { throw new Error('not used') },
      shutdown: async () => {},
    },
    call: async () => { throw new Error('not used') },
    close: async () => {},
    kill: () => {},
  } as unknown as WorkClient
}

function makeStore(): FakeStore {
  return { tasks: new Map(), createCount: 0, listCount: 0, containerShowCount: 0 }
}

// ─── Shared input builder ─────────────────────────────────────────────────────

function makeInput(canonicalEventId: string): WrkqTaskCreateOrFindInput {
  const key = `acp-health:dispatch-timeout:${canonicalEventId}:task`
  return {
    key,
    path: `agent-control-plane/inbox/${key}`,
    projectId: 'agent-control-plane',
    title: `ACP health incident: dispatch timeout (${canonicalEventId})`,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createOrFindWrkqTask — idempotency contract (Phase B RED)', () => {
  test('repeated call with same key returns same taskId without creating a second task', async () => {
    const fakeStore = makeStore()
    const client = makeFakeWorkClient(fakeStore)
    const input = makeInput('evt_repeat_001')

    // RED: both calls throw "not implemented"
    const result1 = await createOrFindWrkqTask(client, input)
    const result2 = await createOrFindWrkqTask(client, input)

    expect(result1.taskId).toBe(result2.taskId)
    expect(fakeStore.createCount).toBe(1)
    expect(result1.created).toBe(true)
    expect(result2.created).toBe(false)
  })

  test('crash-style retry: external create succeeded but result not persisted → second call returns same taskId', async () => {
    const fakeStore = makeStore()
    const client = makeFakeWorkClient(fakeStore)
    const input = makeInput('evt_crash_002')

    // First call: creates the task (simulate caller crashes AFTER create but BEFORE persisting result_json)
    // RED: throws "not implemented"
    const result1 = await createOrFindWrkqTask(client, input)
    expect(result1.created).toBe(true)
    expect(fakeStore.createCount).toBe(1)

    // Reset create count to detect if a SECOND create is attempted
    fakeStore.createCount = 0

    // Second call: simulates retry after crash — must find existing task, NOT create again
    const result2 = await createOrFindWrkqTask(client, input)
    expect(result2.taskId).toBe(result1.taskId)
    expect(fakeStore.createCount).toBe(0)       // NO second create
    expect(result2.created).toBe(false)         // found, not created
  })

  test('different canonical event ids produce different task ids', async () => {
    const fakeStore = makeStore()
    const client = makeFakeWorkClient(fakeStore)

    // RED: throws "not implemented"
    const result1 = await createOrFindWrkqTask(client, makeInput('evt_diff_A'))
    const result2 = await createOrFindWrkqTask(client, makeInput('evt_diff_B'))

    expect(result1.taskId).not.toBe(result2.taskId)
    expect(fakeStore.createCount).toBe(2)
  })

  test('create-or-find never issues a second create for the same key even after multiple calls', async () => {
    const fakeStore = makeStore()
    const client = makeFakeWorkClient(fakeStore)
    const input = makeInput('evt_multi_call_003')

    // RED: throws "not implemented"
    const results = await Promise.all([
      createOrFindWrkqTask(client, input),
      createOrFindWrkqTask(client, input),
      createOrFindWrkqTask(client, input),
    ])

    const taskIds = results.map((r) => r.taskId)
    expect(new Set(taskIds).size).toBe(1)   // All return the same taskId
    expect(fakeStore.createCount).toBeLessThanOrEqual(1)  // At most one create
  })

  test('result contains correct projectId and taskPath', async () => {
    const fakeStore = makeStore()
    const client = makeFakeWorkClient(fakeStore)
    const input = makeInput('evt_fields_004')

    // RED: throws "not implemented"
    const result = await createOrFindWrkqTask(client, input)

    expect(typeof result.taskId).toBe('string')
    expect(result.taskId.length).toBeGreaterThan(0)
    expect(typeof result.projectId).toBe('string')
    expect(result.projectId).toBe('P-00001')   // recovered from container.show
    expect(typeof result.taskPath).toBe('string')
    expect(result.taskPath).toBe(input.path)
    expect(typeof result.created).toBe('boolean')
  })

  test('key format is: acp-health:dispatch-timeout:${canonicalEventId}:task', async () => {
    // Verify the key contract is correct — the implementation must use this exact format.
    // This test documents the required key shape.
    const canonicalEventId = 'evt_key_format_005'
    const input = makeInput(canonicalEventId)
    expect(input.key).toBe(`acp-health:dispatch-timeout:${canonicalEventId}:task`)
    expect(input.path).toContain(input.key)
    expect(input.path).toContain('agent-control-plane/inbox/')
  })
})
