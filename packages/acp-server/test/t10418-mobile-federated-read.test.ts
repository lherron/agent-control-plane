/**
 * T-10418 §5 — remote timeline and history read through HRC's home-routed
 * reads; input and interrupt stay local-only whatever the caller claims.
 *
 * The fake HRC here models a seat homed on svc: this node holds no session row
 * for it and no runtime, and only the scope-keyed reads answer.
 */
import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { CollaborationLedger } from 'wrkq-lib'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import type { MobileWebSocketLike } from '../src/handlers/mobile-ws.js'
import { openMobileWebSocket } from '../src/handlers/mobile.js'
import { withWiredServer } from './fixtures/wired-server.js'

const SCOPE_REF = 'agent:clod:project:foundry:task:T-10417'
const SESSION_REF = `${SCOPE_REF}/lane:main`
const HOST_SESSION_ID = 'hsid-svc-home'
const LEDGER = 'svc-ledger'

const emptyLedger: CollaborationLedger = {
  async pageMessagesByMember() {
    return {
      ledgerIncarnationId: 'wrkq-ledger',
      headMessageSeq: 0,
      hasMoreBefore: false,
      hasMoreAfter: false,
      messages: [],
    }
  },
} as unknown as CollaborationLedger

function event(hrcSeq: number, eventKind = 'turn.message'): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: '2026-10-06T17:20:00.000Z',
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    category: 'turn',
    eventKind,
    replayed: false,
    payload: { text: `message ${hrcSeq}` },
  } as HrcLifecycleEvent
}

type Calls = {
  continuity: unknown[]
  tail: Array<Record<string, unknown>>
  runs: Array<Record<string, unknown>>
  follow: Array<Record<string, unknown>>
  forbidden: string[]
}

function remoteHomeClient(input: {
  capability: boolean
  homeHostSessionId?: string
  follow?: unknown[]
}): { client: AcpHrcClient; calls: Calls } {
  const calls: Calls = { continuity: [], tail: [], runs: [], follow: [], forbidden: [] }
  const forbid = (name: string) => async () => {
    calls.forbidden.push(name)
    throw new Error(`${name} must not be called for a remote record`)
  }
  const client = {
    getHealth: async () => ({ ok: true }),
    getStatus: async () => ({
      node: { nodeId: 'max3' },
      capabilities: input.capability ? { federatedSessionRead: true } : {},
    }),
    // This node has no row for the svc host session.
    listSessions: async () => [],
    listRuntimes: forbid('listRuntimes'),
    listLatestEventBySession: forbid('listLatestEventBySession'),
    getLatestRunForSession: forbid('getLatestRunForSession'),
    getSession: forbid('getSession'),
    deliverLiteralBySelector: forbid('deliverLiteralBySelector'),
    interrupt: forbid('interrupt'),
    getSessionByContinuity: async (target: unknown) => {
      calls.continuity.push(target)
      return {
        continuity: { scopeRef: SCOPE_REF, laneRef: 'main' },
        identity: { kind: 'task', agentId: 'clod', projectId: 'foundry', taskId: 'T-10417' },
        generation: {
          hostSessionId: input.homeHostSessionId ?? HOST_SESSION_ID,
          generation: 1,
          status: 'active',
          createdAt: '2026-10-06T17:13:05.382Z',
        },
        facts: { effectiveStatus: 'active', lastActivityAt: '2026-10-06T17:20:00.000Z' },
        metadata: {},
        metadataSources: {},
      }
    },
    tailEvents: async (options: Record<string, unknown>) => {
      calls.tail.push(options)
      return {
        events: [event(7)],
        ledgerIncarnationId: LEDGER,
        headHrcSeq: 7,
        truncated: false,
      }
    },
    listRuns: async (filter: Record<string, unknown>) => {
      calls.runs.push(filter)
      return []
    },
    watchBoundedEvents: (options: Record<string, unknown>) => {
      calls.follow.push(options)
      return (async function* () {
        for (const record of input.follow ?? []) yield record
      })()
    },
  } as unknown as AcpHrcClient
  return { client, calls }
}

async function openTimeline(client: AcpHrcClient, query: string) {
  const sent: Array<Record<string, unknown>> = []
  const closes: Array<{ code?: number | undefined; reason?: string | undefined }> = []
  const stateStore = openAcpStateStore({ dbPath: ':memory:' })
  const deps = {
    hrcClient: client,
    collaborationLedger: emptyLedger,
    stateStore,
  } as ResolvedAcpServerDeps
  const ws: MobileWebSocketLike = {
    data: {
      deps,
      url: `http://acp.test/v1/mobile/sessions/${HOST_SESSION_ID}/timeline?${query}`,
      kind: 'timeline',
      version: 1,
      hostSessionId: HOST_SESSION_ID,
      abortController: new AbortController(),
    },
    send(raw) {
      sent.push(JSON.parse(raw) as Record<string, unknown>)
      return raw.length
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason })
      this.data.abortController.abort()
    },
  }
  try {
    await openMobileWebSocket(ws)
  } finally {
    stateStore.close()
  }
  return { sent, closes }
}

const REMOTE_QUERY = `sourceKind=remote_runtime_projection&sessionRef=${encodeURIComponent(SESSION_REF)}`

describe('T-10418 remote timeline', () => {
  test('a runtime-less remote continuity opens, follows a new turn, and surfaces home loss as retryable', async () => {
    const { client, calls } = remoteHomeClient({
      capability: true,
      follow: [
        { type: 'ready', ledgerIncarnationId: LEDGER, acceptedAfterHrcSeq: 7, replayHeadHrcSeq: 7 },
        { type: 'event', ledgerIncarnationId: LEDGER, event: event(8) },
        { type: 'home_unreachable', homeNodeId: 'svc', retryable: true, reason: 'disconnected' },
      ],
    })
    const { sent, closes } = await openTimeline(client, REMOTE_QUERY)

    // F13/F24: resolved by scope + lane through the home, never runtime inventory.
    expect(calls.forbidden).toEqual([])
    expect(calls.continuity).toEqual([{ scopeRef: SCOPE_REF, laneRef: 'main' }])
    const snapshot = sent.find((e) => e['type'] === 'snapshot')
    expect(snapshot).toBeDefined()
    // Snapshot reads use the exact home filters.
    expect(calls.tail).toContainEqual({
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      limit: 1,
    })
    expect(calls.runs).toEqual([
      {
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        hostSessionId: HOST_SESSION_ID,
        generation: 1,
        limit: 1,
      },
    ])
    // §5.6: every page and the follow carry scope and lane.
    for (const options of [...calls.tail, ...calls.follow]) {
      expect(options).toMatchObject({ scopeRef: SCOPE_REF, laneRef: 'main' })
    }
    // F2: the turn started after attach arrives as a live atom/frame.
    expect(sent.some((e) => e['type'] === 'atom' || e['type'] === 'frame')).toBe(true)
    // F5: one retryable error, then a close the client reconnects from.
    const errors = sent.filter((e) => e['type'] === 'error')
    expect(errors).toEqual([
      expect.objectContaining({ code: 'session_home_unreachable', retryable: true }),
    ])
    expect(closes.at(-1)?.code).toBe(1013)
  })

  test('F23: a rolled generation on the home is session_not_found', async () => {
    const { client } = remoteHomeClient({ capability: true, homeHostSessionId: 'hsid-newer' })
    const { sent, closes } = await openTimeline(client, REMOTE_QUERY)
    expect(sent.find((e) => e['type'] === 'error')).toMatchObject({ code: 'session_not_found' })
    expect(sent.some((e) => e['type'] === 'snapshot')).toBe(false)
    expect(closes.at(-1)?.code).toBe(1008)
  })

  test('F21: without the HRC capability the remote refusal stays', async () => {
    const { client, calls } = remoteHomeClient({ capability: false })
    const { sent } = await openTimeline(client, REMOTE_QUERY)
    expect(sent).toEqual([expect.objectContaining({ code: 'remote_control_unavailable' })])
    expect(calls.continuity).toEqual([])
  })

  test('§5.3: a remote timeline under the capability must name its sessionRef', async () => {
    const { client } = remoteHomeClient({ capability: true })
    const { sent } = await openTimeline(client, 'sourceKind=remote_runtime_projection')
    expect(sent).toEqual([expect.objectContaining({ code: 'session_ref_required' })])
  })

  test('F21: remote diagnostics stays refused even with the capability', async () => {
    const { client } = remoteHomeClient({ capability: true })
    const sent: Array<Record<string, unknown>> = []
    const ws: MobileWebSocketLike = {
      data: {
        deps: { hrcClient: client } as ResolvedAcpServerDeps,
        url: `http://acp.test/v1/mobile/sessions/${HOST_SESSION_ID}/diagnostics?${REMOTE_QUERY}`,
        kind: 'diagnostics',
        version: 1,
        hostSessionId: HOST_SESSION_ID,
        abortController: new AbortController(),
      },
      send(raw) {
        sent.push(JSON.parse(raw) as Record<string, unknown>)
        return raw.length
      },
      close() {},
    }
    await openMobileWebSocket(ws)
    expect(sent).toEqual([expect.objectContaining({ code: 'remote_control_unavailable' })])
  })
})

describe('T-10418 remote history, health and control isolation', () => {
  test('remote history opens for a runtime-less continuity and pages through the home', async () => {
    const { client, calls } = remoteHomeClient({ capability: true })
    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: `/v1/mobile/history?${REMOTE_QUERY}&hostSessionId=${HOST_SESSION_ID}&generation=1&limit=20`,
        })
        expect(response.status).toBe(200)
        const body = await json<{ atoms: unknown[] }>(response)
        expect(body.atoms.length).toBeGreaterThan(0)
      },
      { hrcClient: client, collaborationLedger: emptyLedger }
    )
    expect(calls.forbidden).toEqual([])
    expect(calls.continuity).toHaveLength(1)
    expect(calls.tail.length).toBeGreaterThan(0)
    for (const options of calls.tail) {
      expect(options).toMatchObject({ scopeRef: SCOPE_REF, laneRef: 'main' })
    }
  })

  test('health advertises remote timeline/history only when HRC declares it', async () => {
    for (const capability of [true, false]) {
      const { client } = remoteHomeClient({ capability })
      await withWiredServer(
        async ({ request, json }) => {
          const body = await json<{ capabilities: Record<string, boolean> }>(
            await request({ method: 'GET', path: '/v1/mobile/health' })
          )
          expect(body.capabilities['remoteTimeline']).toBe(capability)
          expect(body.capabilities['remoteHistory']).toBe(capability)
          expect(body.capabilities['remoteLiteralInput']).toBe(false)
          expect(body.capabilities['remoteInterrupt']).toBe(false)
        },
        { hrcClient: client }
      )
    }
  })

  test('F12: input and interrupt for a remote hostSessionId with sourceKind omitted are refused as today', async () => {
    const { client, calls } = remoteHomeClient({ capability: true })
    await withWiredServer(
      async ({ request, json }) => {
        const input = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/input`,
          body: {
            clientInputId: 'cli-t10418',
            text: 'must not reach svc',
            sessionRef: SESSION_REF,
          },
        })
        expect(input.status).toBe(422)
        expect(await json<{ code: string }>(input)).toMatchObject({ code: 'input_failed' })
        const interrupt = await request({
          method: 'POST',
          path: `/v1/mobile/sessions/${HOST_SESSION_ID}/interrupt`,
          body: { clientInputId: 'cli-t10418-int', sessionRef: SESSION_REF },
        })
        // Today's refusal for a hostSessionId this node does not hold.
        expect(interrupt.status).toBe(422)
        expect(await json<{ code: string }>(interrupt)).toMatchObject({ code: 'interrupt_failed' })
      },
      { hrcClient: client }
    )
    // The remote read lookup is never on the control path.
    expect(calls.continuity).toEqual([])
    expect(calls.forbidden).not.toContain('deliverLiteralBySelector')
    expect(calls.forbidden).not.toContain('interrupt')
  })
})
