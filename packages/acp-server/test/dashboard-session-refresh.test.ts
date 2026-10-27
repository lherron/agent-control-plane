import { describe, expect, test } from 'bun:test'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import type { AcpHrcClient } from '../src/deps.js'
import {
  type DashboardSessionInputs,
  type DashboardSessionReads,
  createDashboardSessionReads,
  createDashboardSessionRefresher,
} from '../src/handlers/dashboard-session-refresh.js'

// T-11794: the dashboard socket used to make four HRC reads per lifecycle
// event per socket. These tests pin the coalescing contract that replaced it.

const NOW = new Date().toISOString()

function session(hostSessionId: string): HrcSessionRecord {
  return {
    hostSessionId,
    scopeRef: `agent:larry:project:agent-spaces:task:${hostSessionId}`,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  } as HrcSessionRecord
}

function event(hrcSeq: number, hostSessionId = 'hsid-a'): HrcLifecycleEvent {
  const record = session(hostSessionId)
  return {
    hrcSeq,
    streamSeq: hrcSeq + 100,
    ts: NOW,
    hostSessionId,
    scopeRef: record.scopeRef,
    laneRef: record.laneRef,
    generation: record.generation,
    category: 'turn',
    eventKind: 'turn.tool_call',
    replayed: false,
    payload: {},
  } as HrcLifecycleEvent
}

function countingClient(options: { fail?: boolean; sessions?: string[] } = {}) {
  const calls = { sessions: 0, runtimes: 0, latest: 0, run: 0 }
  const known = new Set(options.sessions ?? ['hsid-a', 'hsid-b'])
  const client = {
    listSessions: async (filter: { scopeRef?: string }) => {
      calls.sessions += 1
      if (options.fail === true) throw new Error('hrc unavailable')
      return [...known].map(session).filter((record) => record.scopeRef === filter.scopeRef)
    },
    listRuntimes: async () => {
      calls.runtimes += 1
      return [] as HrcRuntimeSnapshot[]
    },
    listLatestEventBySession: async () => {
      calls.latest += 1
      return [] as HrcLifecycleEvent[]
    },
    getLatestRunForSession: async () => {
      calls.run += 1
      return null as HrcRunRecord | null
    },
  } as unknown as AcpHrcClient
  return { client, calls }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function recorder(reads: DashboardSessionReads, coalesceMs = 20) {
  const refreshed: Array<{ hrcSeq: number; hostSessionId: string | undefined }> = []
  const errors: unknown[] = []
  const abortController = new AbortController()
  const refresher = createDashboardSessionRefresher({
    reads,
    coalesceMs,
    signal: abortController.signal,
    onRefresh: (latest, inputs: DashboardSessionInputs | undefined) => {
      refreshed.push({ hrcSeq: latest.hrcSeq, hostSessionId: inputs?.record.hostSessionId })
    },
    onError: (error) => errors.push(error),
  })
  return { refresher, refreshed, errors, abortController }
}

describe('dashboard session refresh coalescing (T-11794)', () => {
  test('an event after a window closes gets its own trailing refresh', async () => {
    const { client, calls } = countingClient()
    const { refresher, refreshed } = recorder(createDashboardSessionReads(client))

    refresher.note(event(1))
    await sleep(60)
    refresher.note(event(2))
    await sleep(60)

    expect(refreshed.map((entry) => entry.hrcSeq)).toEqual([1, 2])
    expect(calls.run).toBe(2)
  })

  test('an event that arrives while its read is in flight is not served by that read', async () => {
    let releaseFirst: (() => void) | undefined
    const { client, calls } = countingClient()
    const slow = {
      ...client,
      getLatestRunForSession: async (
        ...args: Parameters<AcpHrcClient['getLatestRunForSession']>
      ) => {
        if (calls.run === 0) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return client.getLatestRunForSession(...args)
      },
    } as AcpHrcClient
    const { refresher, refreshed } = recorder(createDashboardSessionReads(slow))

    refresher.note(event(1))
    await sleep(40) // window closed, first read waiting on releaseFirst
    refresher.note(event(2))
    await sleep(40)
    releaseFirst?.()
    await sleep(60)

    expect(refreshed.map((entry) => entry.hrcSeq)).toEqual([1, 2])
    expect(calls.run).toBe(2)
  })

  test('sockets share a read that started after they received the event', async () => {
    const { client, calls } = countingClient()
    const reads = createDashboardSessionReads(client)
    const first = recorder(reads)
    const second = recorder(reads, 25)

    const shared = event(7)
    first.refresher.note(shared)
    second.refresher.note(shared)
    await sleep(80)

    expect(first.refreshed).toEqual([{ hrcSeq: 7, hostSessionId: 'hsid-a' }])
    expect(second.refreshed).toEqual([{ hrcSeq: 7, hostSessionId: 'hsid-a' }])
    expect(calls).toEqual({ sessions: 1, runtimes: 1, latest: 1, run: 1 })
  })

  test('a read that started before the event arrived is not reused', async () => {
    const { client, calls } = countingClient()
    const reads = createDashboardSessionReads(client)
    const first = recorder(reads)

    first.refresher.note(event(1))
    await sleep(60)
    const second = recorder(reads)
    second.refresher.note(event(1))
    await sleep(60)

    expect(second.refreshed).toEqual([{ hrcSeq: 1, hostSessionId: 'hsid-a' }])
    expect(calls.run).toBe(2)
  })

  test('drain flushes pending sessions at once and waits for them', async () => {
    const { client } = countingClient()
    const { refresher, refreshed } = recorder(createDashboardSessionReads(client), 10_000)

    refresher.note(event(1, 'hsid-a'))
    refresher.note(event(2, 'hsid-b'))
    await refresher.drain()

    expect(refreshed.map((entry) => entry.hrcSeq)).toEqual([1, 2])
  })

  test('abort drops pending refreshes', async () => {
    const { client, calls } = countingClient()
    const { refresher, refreshed, abortController } = recorder(createDashboardSessionReads(client))

    refresher.note(event(1))
    abortController.abort()
    await sleep(60)
    await refresher.drain()

    expect(refreshed).toEqual([])
    expect(calls.sessions).toBe(0)
  })
})
