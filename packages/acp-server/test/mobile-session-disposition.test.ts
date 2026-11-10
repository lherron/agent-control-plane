import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type { HrcLifecycleEvent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { SessionGetResponse, SessionMetadataTarget } from 'hrc-sdk'
import type { CollaborationLedger } from 'wrkq-lib'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import type { MobileWebSocketLike } from '../src/handlers/mobile-ws.js'
import { openMobileWebSocket } from '../src/handlers/mobile.js'

// T-13191: socket summaries built from a plain HrcSessionRecord take HRC's
// parked disposition from the single-session get, but only when the summary
// would go out inactive with no runtime.

const NOW = new Date().toISOString()
const PARKED_AT = '2026-11-10T17:00:00.000Z'
const SESSION: HrcSessionRecord = {
  hostSessionId: 'hsid-foundry',
  scopeRef: 'agent:foundry:project:agents:task:primary',
  laneRef: 'main',
  generation: 4,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  lastAppliedIntentJson: {
    harness: { harness: 'codex', provider: 'openai', interactive: true },
    execution: { preferredMode: 'headless' },
  } as HrcSessionRecord['lastAppliedIntentJson'],
}
const RUNTIME: HrcRuntimeSnapshot = {
  runtimeId: 'rt-foundry',
  hostSessionId: SESSION.hostSessionId,
  scopeRef: SESSION.scopeRef,
  laneRef: SESSION.laneRef,
  generation: SESSION.generation,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'busy',
  supportsInflightInput: true,
  createdAt: NOW,
  updatedAt: NOW,
}

function event(hrcSeq: number): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts: NOW,
    hostSessionId: SESSION.hostSessionId,
    scopeRef: SESSION.scopeRef,
    laneRef: SESSION.laneRef,
    generation: SESSION.generation,
    category: 'session',
    eventKind: 'session.updated',
    replayed: false,
    payload: {},
  }
}

type Scenario = {
  name: string
  runtimes: HrcRuntimeSnapshot[]
  get: () => Promise<Pick<SessionGetResponse, 'disposition' | 'dispositionAt'>>
  expected: { disposition: 'parked' | null; dispositionAt: string | null }
  expectGets: number
}

const SCENARIOS: Scenario[] = [
  {
    name: 'parked: inactive with no runtime reads the get',
    runtimes: [],
    get: async () => ({ disposition: 'parked', dispositionAt: PARKED_AT }),
    expected: { disposition: 'parked', dispositionAt: PARKED_AT },
    expectGets: 1,
  },
  {
    name: 'woken: an active runtime costs no read and carries null',
    runtimes: [RUNTIME],
    get: async () => ({ disposition: 'parked', dispositionAt: PARKED_AT }),
    expected: { disposition: null, dispositionAt: null },
    expectGets: 0,
  },
  {
    name: 'unparked inactive: the get answers null',
    runtimes: [],
    get: async () => ({ disposition: null, dispositionAt: null }),
    expected: { disposition: null, dispositionAt: null },
    expectGets: 1,
  },
  {
    name: 'get fails: null, and the event still goes out',
    runtimes: [],
    get: async () => {
      throw new Error('hrc get refused')
    },
    expected: { disposition: null, dispositionAt: null },
    expectGets: 1,
  },
]

function baseClient(scenario: Scenario, gets: SessionMetadataTarget[]) {
  return {
    listSessions: async () => [SESSION],
    getSession: async () => SESSION,
    listRuntimes: async () => scenario.runtimes,
    listLatestEventBySession: async () => [event(1)],
    getLatestRunForSession: async () => undefined,
    listRuns: async () => [],
    getStatus: async () => ({ node: { nodeId: 'svc' } }) as never,
    getSessionByContinuity: async (target: SessionMetadataTarget) => {
      gets.push(target)
      return scenario.get()
    },
  }
}

describe('dashboard socket session_updated carries disposition (T-13191)', () => {
  test.each(SCENARIOS)('$name', async (scenario) => {
    const gets: SessionMetadataTarget[] = []
    const hrcEvents = [event(1), event(2)]
    const hrcClient = {
      ...baseClient(scenario, gets),
      listSessionsPage: async () => ({
        items: [],
        eventHighWater: { svc: 1 },
        complete: true,
        peerStatus: {},
      }),
      getSessionFacets: async () => ({
        total: 0,
        byEffectiveStatus: {},
        byExecutionMode: {},
        byAgentId: {},
        byNodeId: {},
        complete: true,
        peerStatus: {},
      }),
      watch: (options: { fromSeq?: number } = {}) =>
        (async function* () {
          for (const candidate of hrcEvents) {
            if (candidate.hrcSeq >= (options.fromSeq ?? 1)) yield candidate
          }
        })(),
    } as unknown as AcpHrcClient
    const sent: Array<Record<string, unknown>> = []
    const ws: MobileWebSocketLike = {
      data: {
        deps: { hrcClient } as ResolvedAcpServerDeps,
        url: 'http://acp.local/v2/mobile/dashboard?fromHrcSeq=2',
        kind: 'dashboard',
        version: 2,
        abortController: new AbortController(),
      },
      send(message) {
        sent.push(JSON.parse(message) as Record<string, unknown>)
        return message.length
      },
      close() {},
    }

    await openMobileWebSocket(ws)

    const updates = sent.filter((envelope) => envelope['type'] === 'session_updated')
    expect(updates).toHaveLength(1)
    const session = updates[0]!['session'] as Record<string, unknown>
    expect(session).toHaveProperty('disposition', scenario.expected.disposition)
    expect(session).toHaveProperty('dispositionAt', scenario.expected.dispositionAt)
    expect(session['summaryStatus']).toBe(scenario.runtimes.length === 0 ? 'inactive' : 'active')
    expect(gets).toEqual(
      Array.from({ length: scenario.expectGets }, () => ({
        scopeRef: SESSION.scopeRef,
        laneRef: SESSION.laneRef,
      }))
    )
  })
})

function emptyLedger(): CollaborationLedger {
  return {
    async pageMessagesByMember() {
      return {
        ledgerIncarnationId: 'wrkq-disposition',
        headMessageSeq: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
        messages: [],
      }
    },
    async listMessagesByMember() {
      return { messages: [] }
    },
    async listMessagesByRoom() {
      return { messages: [] }
    },
    async say() {
      throw new Error('timeline test does not write collaboration messages')
    },
  }
}

describe('timeline socket snapshot session carries disposition (T-13191)', () => {
  test.each(SCENARIOS)('$name', async (scenario) => {
    const gets: SessionMetadataTarget[] = []
    const stateStore = openAcpStateStore({ dbPath: ':memory:' })
    const hrcClient = {
      ...baseClient(scenario, gets),
      tailEvents: async () => ({
        events: [event(1)],
        ledgerIncarnationId: 'hrc-disposition',
        headHrcSeq: 1,
        truncated: false,
      }),
      watchBoundedEvents: () => (async function* () {})(),
    } as unknown as AcpHrcClient
    const sent: Array<Record<string, unknown>> = []
    const ws: MobileWebSocketLike = {
      data: {
        deps: {
          hrcClient,
          stateStore,
          collaborationLedger: emptyLedger(),
        } as ResolvedAcpServerDeps,
        url: `http://acp.test/v1/mobile/sessions/${SESSION.hostSessionId}/timeline`,
        kind: 'timeline',
        version: 1,
        hostSessionId: SESSION.hostSessionId,
        abortController: new AbortController(),
      },
      send(raw) {
        const envelope = JSON.parse(raw) as Record<string, unknown>
        sent.push(envelope)
        if (envelope['type'] === 'snapshot') this.data.abortController.abort()
        return raw.length
      },
      close() {
        this.data.abortController.abort()
      },
    }

    try {
      await openMobileWebSocket(ws)
    } finally {
      stateStore.close()
    }

    const snapshot = sent.find((envelope) => envelope['type'] === 'snapshot')
    const session = snapshot?.['session'] as Record<string, unknown>
    expect(session).toHaveProperty('disposition', scenario.expected.disposition)
    expect(session).toHaveProperty('dispositionAt', scenario.expected.dispositionAt)
    expect(gets).toHaveLength(scenario.expectGets)
  })
})
