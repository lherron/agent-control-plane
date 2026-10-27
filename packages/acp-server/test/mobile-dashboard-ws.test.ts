import { afterEach, describe, expect, test } from 'bun:test'

import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import type { AcpHrcClient, ResolvedAcpServerDeps } from '../src/deps.js'
import type { MobileWebSocketLike } from '../src/handlers/mobile-ws.js'
import {
  closeMobileWebSocket,
  handleMobileWebSocketMessage,
  openMobileWebSocket,
} from '../src/handlers/mobile.js'

// Use a fresh timestamp so the dashboard replay age gate
// (ACP_MOBILE_DASHBOARD_MAX_REPLAY_AGE_MS) never trips on wall-clock drift.
// A hardcoded date silently rots: replays older than the policy window get
// rejected as replay_gap_too_large once enough real time passes.
const NOW = new Date().toISOString()
const LARGE_INITIAL_PROMPT = 'mobile-dashboard-heavy-intent-payload '.repeat(1_000)
const SESSION: HrcSessionRecord = {
  hostSessionId: 'hsid-mobile-dashboard',
  scopeRef: 'agent:larry:project:agent-spaces:task:T-01507',
  laneRef: 'main',
  generation: 1,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  continuation: { provider: 'openai', kind: 'session', key: 'resume-mobile-dashboard' },
  lastAppliedIntentJson: {
    placement: { nodeId: 'local' },
    harness: { harness: 'codex', provider: 'openai' },
    execution: { preferredMode: 'interactive' },
    initialPrompt: LARGE_INITIAL_PROMPT,
  },
}
const RUNTIME: HrcRuntimeSnapshot = {
  runtimeId: 'runtime-mobile-dashboard',
  hostSessionId: SESSION.hostSessionId,
  scopeRef: SESSION.scopeRef,
  laneRef: SESSION.laneRef,
  generation: SESSION.generation,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'busy',
  tmuxJson: { paneId: 'pane-1' },
  supportsInflightInput: true,
  activeRunId: 'run-mobile-dashboard',
  createdAt: NOW,
  updatedAt: NOW,
}
const RUN: HrcRunRecord = {
  runId: 'run-mobile-dashboard',
  hostSessionId: SESSION.hostSessionId,
  runtimeId: RUNTIME.runtimeId,
  scopeRef: SESSION.scopeRef,
  laneRef: SESSION.laneRef,
  generation: SESSION.generation,
  transport: 'tmux',
  status: 'running',
  acceptedAt: NOW,
  startedAt: NOW,
  updatedAt: NOW,
}

type SentEnvelope = Record<string, unknown>

function event(hrcSeq: number, overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq + 100,
    ts: NOW,
    hostSessionId: SESSION.hostSessionId,
    scopeRef: SESSION.scopeRef,
    laneRef: SESSION.laneRef,
    generation: SESSION.generation,
    category: 'session',
    eventKind: 'session.updated',
    replayed: false,
    payload: { hrcSeq },
    ...overrides,
  }
}

function createDashboardClient(events: HrcLifecycleEvent[]): AcpHrcClient {
  return {
    listSessions: async () => [SESSION],
    getSession: async () => SESSION,
    listRuntimes: async () => [RUNTIME],
    listLatestEventBySession: async () => [events.at(-1)].filter(Boolean) as HrcLifecycleEvent[],
    getLatestRunForSession: async () => RUN,
    listRuns: async () => [RUN],
    listSessionsPage: async () => ({
      items: [
        {
          nodeId: 'svc',
          hostSessionId: SESSION.hostSessionId,
          scopeRef: SESSION.scopeRef,
          laneRef: SESSION.laneRef,
          generation: SESSION.generation,
          agentId: 'larry',
          projectId: 'agent-spaces',
          createdAt: NOW,
          effectiveStatus: 'active',
          executionMode: 'interactive',
          lastActivityAt: NOW,
        },
      ],
      eventHighWater: { svc: events.at(-1)?.hrcSeq ?? 0 },
      complete: true,
      peerStatus: {},
    }),
    getSessionFacets: async () => ({
      total: 1,
      byEffectiveStatus: { active: 1 },
      byExecutionMode: { interactive: 1 },
      byAgentId: { larry: 1 },
      byNodeId: { svc: 1 },
      complete: true,
      peerStatus: {},
    }),
    getStatus: async () => ({ node: { nodeId: 'svc' } }) as never,
    watch: (options) =>
      (async function* () {
        const fromSeq = options?.fromSeq ?? 1
        for (const candidate of events) {
          if (candidate.hrcSeq >= fromSeq) yield candidate
        }
      })(),
  } as unknown as AcpHrcClient
}

function createDashboardSocket(input: {
  hrcClient: AcpHrcClient
  url?: string | undefined
  version?: 1 | 2 | undefined
  kind?: 'dashboard' | 'timeline' | 'diagnostics' | undefined
  hostSessionId?: string | undefined
}): {
  ws: MobileWebSocketLike
  sent: SentEnvelope[]
  closed: Array<{ code?: number; reason?: string }>
} {
  const sent: SentEnvelope[] = []
  const closed: Array<{ code?: number; reason?: string }> = []
  const deps = { hrcClient: input.hrcClient } as ResolvedAcpServerDeps
  const ws: MobileWebSocketLike = {
    data: {
      deps,
      url: input.url ?? 'http://acp.local/v1/mobile/dashboard',
      kind: input.kind ?? 'dashboard',
      version: input.version ?? 1,
      ...(input.hostSessionId !== undefined ? { hostSessionId: input.hostSessionId } : {}),
      abortController: new AbortController(),
    },
    send(message) {
      sent.push(JSON.parse(message) as SentEnvelope)
      return message.length
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason })
    },
  }
  return { ws, sent, closed }
}

afterEach(() => {
  process.env['ACP_MOBILE_DASHBOARD_MAX_REPLAY_EVENTS'] = undefined
  process.env['ACP_MOBILE_DASHBOARD_MAX_REPLAY_AGE_MS'] = undefined
})

describe('WS /v2/mobile/dashboard federation projection', () => {
  test('keeps the retired accept capability false on local and peer node summaries', async () => {
    const client = createDashboardClient([event(1)])
    client.listSessionsPage = undefined
    client.getSessionFacets = undefined
    client.listFederationPeerHealth = async () => [
      {
        nodeId: 'max3',
        state: 'healthy',
        checkedAt: NOW,
        answeredAt: NOW,
        latencyMs: 4,
        protocolVersion: '1',
        capabilities: { locate: true, health: true, runtimeProjection: true },
      },
    ]
    client.listFederatedRuntimes = async () => ({
      localNodeId: 'svc',
      generatedAt: NOW,
      nodes: [],
    })
    const { ws, sent } = createDashboardSocket({ hrcClient: client, version: 2 })

    await openMobileWebSocket(ws)

    expect(sent.find((envelope) => envelope.type === 'federation_snapshot')).toMatchObject({
      type: 'federation_snapshot',
      nodes: expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'svc',
          capabilities: {
            accept: false,
            locate: true,
            health: true,
            runtimeProjection: true,
          },
        }),
        expect.objectContaining({
          nodeId: 'max3',
          capabilities: {
            accept: false,
            locate: true,
            health: true,
            runtimeProjection: true,
          },
        }),
      ]),
    })
  })

  test('sends one bounded HRC-owned federated page, then page-derived node health', async () => {
    const client = createDashboardClient([event(1), event(2)])
    const latestEventRequests: unknown[] = []
    client.listLatestEventBySession = async (filter) => {
      latestEventRequests.push(filter)
      return [event(2)]
    }
    client.listSessionsPage = async () => ({
      items: [
        {
          nodeId: 'svc',
          hostSessionId: SESSION.hostSessionId,
          scopeRef: SESSION.scopeRef,
          laneRef: SESSION.laneRef,
          generation: SESSION.generation,
          agentId: 'larry',
          projectId: 'agent-spaces',
          createdAt: NOW,
          effectiveStatus: 'active',
          executionMode: 'interactive',
          lastActivityAt: NOW,
        },
        {
          nodeId: 'max3',
          hostSessionId: 'hsid-collision-safe',
          scopeRef: 'agent:daedalus:project:hrc-runtime',
          laneRef: 'main',
          generation: 4,
          agentId: 'daedalus',
          projectId: 'hrc-runtime',
          createdAt: NOW,
          effectiveStatus: 'active',
          executionMode: 'interactive',
          lastActivityAt: NOW,
        },
      ],
      eventHighWater: { svc: 1, max3: 12 },
      complete: true,
      peerStatus: { max3: { state: 'healthy', checkedAt: NOW } },
    })
    client.getSessionFacets = async () => ({
      total: 2,
      byEffectiveStatus: { active: 2 },
      byExecutionMode: { interactive: 2 },
      byAgentId: { larry: 1, daedalus: 1 },
      byNodeId: { svc: 1, max3: 1 },
      complete: true,
      peerStatus: { max3: { state: 'healthy', checkedAt: NOW } },
    })
    const { ws, sent } = createDashboardSocket({
      hrcClient: client,
      url: 'http://acp.local/v2/mobile/dashboard',
      version: 2,
    })

    await openMobileWebSocket(ws)

    expect(sent.slice(0, 2).map((envelope) => envelope.type)).toEqual([
      'dashboard_snapshot',
      'federation_snapshot',
    ])
    const pageSessions = sent[0]!.sessions as SentEnvelope[]
    expect(pageSessions).toHaveLength(2)
    expect(sent[0]!.cursors).toEqual({ lastHrcSeq: 1, lastStreamSeq: 101, nextFromHrcSeq: 2 })
    expect(sent[0]!.pageInfo).toMatchObject({
      localNodeId: 'svc',
      eventHighWater: { svc: 1, max3: 12 },
      complete: true,
    })
    expect(sent[0]!.facets).toMatchObject({ total: 2 })
    expect(sent[0]!.recentEventsBySession).toEqual({
      [`${SESSION.hostSessionId}:${SESSION.generation}`]: [expect.objectContaining({ hrcSeq: 1 })],
    })
    expect(sent).toContainEqual(expect.objectContaining({ type: 'hrc_event', hrcSeq: 2 }))
    expect(latestEventRequests).toEqual([
      { hostSessionId: SESSION.hostSessionId, generation: SESSION.generation },
    ])
    const federation = sent[1]!
    expect(federation.localNodeId).toBe('svc')
    expect(federation.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'svc', state: 'healthy' }),
        expect.objectContaining({
          nodeId: 'max3',
          state: 'healthy',
          answeredAt: expect.any(String),
        }),
      ])
    )
    expect(federation.sessions).toEqual([])
    expect(pageSessions[1]).toMatchObject({
      nodeId: 'max3',
      sourceKind: 'remote_runtime_projection',
      sessionRef: 'agent:daedalus:project:hrc-runtime/lane:main',
      hostSessionId: 'hsid-collision-safe',
      generation: 4,
      lastHrcSeq: 0,
      lastMessageSeq: 0,
      capabilities: {
        summary: true,
        semanticDm: true,
        timeline: false,
        history: false,
        literalInput: false,
        interrupt: false,
        answerPrompt: false,
      },
    })
  })

  test('keeps the local dashboard usable when the HRC page reports a failed peer', async () => {
    const client = createDashboardClient([event(1)])
    client.listSessionsPage = async () => ({
      items: [],
      eventHighWater: { svc: 1 },
      complete: false,
      peerStatus: {
        max3: { state: 'unreachable', checkedAt: NOW, detail: 'peer health timed out' },
      },
    })
    client.getSessionFacets = async () => ({
      total: 0,
      byEffectiveStatus: {},
      byExecutionMode: {},
      byAgentId: {},
      byNodeId: { svc: 0, max3: 0 },
      complete: false,
      peerStatus: {
        max3: { state: 'unreachable', checkedAt: NOW, detail: 'peer health timed out' },
      },
    })
    const { ws, sent, closed } = createDashboardSocket({
      hrcClient: client,
      url: 'http://acp.local/v2/mobile/dashboard',
      version: 2,
    })

    await openMobileWebSocket(ws)

    expect(sent[0]).toMatchObject({
      type: 'dashboard_snapshot',
      pageInfo: { complete: false, peerStatus: { max3: 'unreachable' } },
    })
    expect(sent[1]).toMatchObject({
      type: 'federation_snapshot',
      sessions: [],
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'max3', state: 'unreachable' }),
      ]),
    })
    expect(closed).toEqual([])
  })

  test('preserves cached remote rows and source freshness when a node is unreachable', async () => {
    const client = createDashboardClient([event(1)])
    const answeredAt = '2026-07-22T16:00:00.000Z'
    const checkedAt = '2026-07-22T17:00:00.000Z'
    client.listSessionsPage = async () => ({
      items: [
        {
          nodeId: 'max3',
          hostSessionId: 'hsid-cached-max3',
          scopeRef: 'agent:daedalus:project:hrc-runtime',
          laneRef: 'main',
          generation: 4,
          agentId: 'daedalus',
          projectId: 'hrc-runtime',
          createdAt: answeredAt,
          effectiveStatus: 'active',
          executionMode: 'interactive',
          lastActivityAt: answeredAt,
        },
      ],
      eventHighWater: { svc: 1 },
      complete: false,
      peerStatus: { max3: { state: 'unreachable', checkedAt, detail: 'peer asleep' } },
    })
    client.getSessionFacets = async () => ({
      total: 1,
      byEffectiveStatus: { active: 1 },
      byExecutionMode: { interactive: 1 },
      byAgentId: { daedalus: 1 },
      byNodeId: { svc: 0, max3: 1 },
      complete: false,
      peerStatus: { max3: { state: 'unreachable', checkedAt, detail: 'peer asleep' } },
    })
    const { ws, sent } = createDashboardSocket({
      hrcClient: client,
      url: 'http://acp.local/v2/mobile/dashboard',
      version: 2,
    })

    await openMobileWebSocket(ws)

    expect(sent[1]!.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'max3',
          state: 'unreachable',
        }),
      ])
    )
    expect(sent[0]!.sessions).toEqual([
      expect.objectContaining({
        nodeId: 'max3',
        sourceKind: 'remote_runtime_projection',
        projectionState: 'unreachable',
        projectionCheckedAt: checkedAt,
        summaryStatus: 'active',
      }),
    ])
  })
})

describe('remote projection stream refusal', () => {
  test('refuses remote timeline before resolving a local session', async () => {
    let listSessionsCalls = 0
    const client = {
      listSessions: async () => {
        listSessionsCalls += 1
        return [SESSION]
      },
    } as unknown as AcpHrcClient
    const { ws, sent, closed } = createDashboardSocket({
      hrcClient: client,
      url: `http://acp.local/v1/mobile/sessions/${SESSION.hostSessionId}/timeline?sourceKind=remote_runtime_projection`,
      kind: 'timeline',
      hostSessionId: SESSION.hostSessionId,
    })

    await openMobileWebSocket(ws)

    // The canonical mobile error envelope: exactly type, code and message.
    expect(sent).toEqual([
      { type: 'error', code: 'remote_control_unavailable', message: expect.any(String) },
    ])
    expect(closed).toEqual([{ code: 1008, reason: 'remote control unavailable' }])
    expect(listSessionsCalls).toBe(0)
  })
})

describe('WS /v1/mobile/dashboard', () => {
  test('opening the dashboard reads HRC session freshness exactly once for index and cursor', async () => {
    const hrcEvents = [event(41), event(42)]
    const baseClient = createDashboardClient(hrcEvents)
    let latestCalls = 0
    const client = {
      ...baseClient,
      listLatestEventBySession: async (
        ...args: Parameters<AcpHrcClient['listLatestEventBySession']>
      ) => {
        latestCalls += 1
        return baseClient.listLatestEventBySession(...args)
      },
    } as AcpHrcClient
    const { ws } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    expect(latestCalls).toBe(1)
  })

  test('sends snapshot with cursors, nested DTO, and bounded recent events', async () => {
    const hrcEvents = Array.from({ length: 12 }, (_, index) => event(index + 1))
    const { ws, sent } = createDashboardSocket({
      hrcClient: createDashboardClient(hrcEvents),
    })

    await openMobileWebSocket(ws)

    const snapshot = sent[0]!
    expect(snapshot.type).toBe('dashboard_snapshot')
    expect(snapshot.cursors).toEqual({
      lastHrcSeq: 12,
      lastStreamSeq: 112,
      nextFromHrcSeq: 13,
    })
    const sessions = snapshot.sessions as Array<Record<string, unknown>>
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.summaryStatus).toBe('active')
    expect(sessions[0]!.session).toMatchObject({ status: 'active', generation: 1 })
    expect((sessions[0]!.session as Record<string, unknown>).continuation).toBeUndefined()
    expect((sessions[0]!.session as Record<string, unknown>).lastAppliedIntent).toBeUndefined()
    expect(sessions[0]!.runtime).toMatchObject({
      runtimeId: RUNTIME.runtimeId,
      activeRunId: RUN.runId,
      supportsInflightInput: true,
      adopted: false,
    })
    expect(sessions[0]!.run).toMatchObject({ runId: RUN.runId, status: 'running' })
    expect(JSON.stringify(sessions[0])).not.toContain(LARGE_INITIAL_PROMPT)

    const recent = snapshot.recentEventsBySession as Record<string, SentEnvelope[]>
    const bucket = recent[`${SESSION.hostSessionId}:${SESSION.generation}`]!
    expect(bucket.map((item) => item.hrcSeq)).toEqual([8, 9, 10, 11, 12])
  })

  test.each([
    { query: '', includesInternals: false },
    { query: '?sessionDetails=true', includesInternals: true },
    { query: '?raw=true', includesInternals: true },
    { query: '?raw=TRUE', includesInternals: false },
    { query: '?raw=1', includesInternals: false },
  ])(
    'heavyweight session internals are included only for sessionDetails=true or the literal raw=true: "$query"',
    async ({ query, includesInternals }) => {
      const { ws, sent } = createDashboardSocket({
        hrcClient: createDashboardClient([event(1)]),
        url: `http://acp.local/v1/mobile/dashboard${query}`,
      })

      await openMobileWebSocket(ws)

      const sessions = (sent[0] as Record<string, unknown>).sessions as Array<
        Record<string, unknown>
      >
      const session = sessions[0]!.session as Record<string, unknown>
      if (includesInternals) {
        expect(session.continuation).toEqual(SESSION.continuation)
        expect(session.lastAppliedIntent).toEqual(SESSION.lastAppliedIntentJson)
        expect(JSON.stringify(session)).toContain(LARGE_INITIAL_PROMPT)
      } else {
        expect(session.continuation).toBeUndefined()
        expect(session.lastAppliedIntent).toBeUndefined()
        expect(JSON.stringify(session)).not.toContain(LARGE_INITIAL_PROMPT)
      }
    }
  )

  test.each([
    {
      runtimeState: 'a terminated runtime under an active session record',
      runtimes: [{ ...RUNTIME, status: 'terminated' }] as HrcRuntimeSnapshot[],
      latestRun: RUN as HrcRunRecord | undefined,
      expected: { summaryStatus: 'inactive', sessionStatus: 'active' },
    },
    {
      runtimeState: 'a detached external runtime',
      runtimes: [{ ...RUNTIME, status: 'detached' }] as HrcRuntimeSnapshot[],
      latestRun: RUN as HrcRunRecord | undefined,
      expected: { summaryStatus: 'detached', status: 'detached', runtimeStatus: 'detached' },
    },
    {
      runtimeState: 'no attached runtime',
      runtimes: [] as HrcRuntimeSnapshot[],
      latestRun: undefined as HrcRunRecord | undefined,
      expected: { summaryStatus: 'inactive' },
    },
  ])(
    'summaryStatus derives from runtime state: $runtimeState',
    async ({ runtimes, latestRun, expected }) => {
      const client = {
        listSessions: async () => [SESSION],
        listRuntimes: async () => runtimes,
        listLatestEventBySession: async () => [event(1)],
        getLatestRunForSession: async () => latestRun,
        listRuns: async () => (latestRun === undefined ? [] : [latestRun]),
        watch: () => (async function* () {})(),
      } as unknown as AcpHrcClient
      const { ws, sent } = createDashboardSocket({ hrcClient: client })

      await openMobileWebSocket(ws)

      const sessions = (sent[0] as Record<string, unknown>).sessions as Array<
        Record<string, unknown>
      >
      expect(sessions[0]!.summaryStatus).toBe(expected.summaryStatus)
      if ('sessionStatus' in expected) {
        expect((sessions[0]!.session as Record<string, unknown>).status).toBe(
          expected.sessionStatus
        )
      }
      if ('status' in expected) {
        expect(sessions[0]!.status).toBe(expected.status)
      }
      if ('runtimeStatus' in expected) {
        expect(sessions[0]!.runtime).toMatchObject({ status: expected.runtimeStatus })
      }
    }
  )

  test('replays from fromHrcSeq, then live streams from snapshot high water without duplicates', async () => {
    process.env['ACP_MOBILE_DASHBOARD_MAX_REPLAY_AGE_MS'] = String(7 * 24 * 60 * 60 * 1000)
    const hrcEvents = [event(1), event(2), event(3), event(4), event(4)]
    const { ws, sent } = createDashboardSocket({
      hrcClient: createDashboardClient(hrcEvents),
      url: 'http://acp.local/v1/mobile/dashboard?fromHrcSeq=2&recentEventsPerSession=1',
    })

    await openMobileWebSocket(ws)

    const hrcSeqs = sent
      .filter((envelope) => envelope.type === 'hrc_event')
      .map((envelope) => envelope.hrcSeq)
    expect(hrcSeqs).toEqual([2, 3])
    // T-11794: one session's replayed events coalesce into one refresh at the
    // last hrcSeq; the hrc_event frames are not coalesced.
    const sessionUpdates = sent.filter((envelope) => envelope.type === 'session_updated')
    expect(sessionUpdates.map((envelope) => envelope.hrcSeq)).toEqual([3])
  })

  test('T-11794: a live burst reads HRC once and sends every frame, then one session_updated', async () => {
    const hrcEvents = [event(1), event(2), event(3), event(4), event(5)]
    const baseClient = createDashboardClient(hrcEvents)
    let runReads = 0
    const client = {
      ...baseClient,
      // Snapshot the high water at 1 so seqs 2..5 arrive on the live follow.
      listLatestEventBySession: async () => [hrcEvents[0]!],
      getLatestRunForSession: async (
        ...args: Parameters<AcpHrcClient['getLatestRunForSession']>
      ) => {
        runReads += 1
        return baseClient.getLatestRunForSession(...args)
      },
    } as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    expect(
      sent.filter((envelope) => envelope.type === 'hrc_event').map((envelope) => envelope.hrcSeq)
    ).toEqual([2, 3, 4, 5])
    const updates = sent.filter((envelope) => envelope.type === 'session_updated')
    expect(updates.map((envelope) => envelope.hrcSeq)).toEqual([5])
    expect((updates[0]!.session as Record<string, unknown>).hostSessionId).toBe(
      SESSION.hostSessionId
    )
    expect(runReads).toBe(1)
  })

  test('T-11794: interleaved live sessions each refresh once at their last event', async () => {
    const otherSession = {
      ...SESSION,
      hostSessionId: 'hsid-other',
      scopeRef: 'agent:larry:project:agent-spaces:task:T-other',
    }
    const otherRuntime = {
      ...RUNTIME,
      hostSessionId: otherSession.hostSessionId,
      scopeRef: otherSession.scopeRef,
    }
    const otherRun = {
      ...RUN,
      hostSessionId: otherSession.hostSessionId,
      scopeRef: otherSession.scopeRef,
    }
    const hrcEvents = [
      event(1),
      event(2),
      event(3, { hostSessionId: otherSession.hostSessionId, scopeRef: otherSession.scopeRef }),
      event(4),
    ]
    const baseClient = createDashboardClient(hrcEvents)
    let runReads = 0
    const client = {
      ...baseClient,
      listSessions: async (filter: { scopeRef?: string } = {}) =>
        [SESSION, otherSession].filter(
          (record) => filter.scopeRef === undefined || record.scopeRef === filter.scopeRef
        ),
      listRuntimes: async () => [RUNTIME, otherRuntime],
      listLatestEventBySession: async () => [hrcEvents[0]!],
      listRuns: async () => [RUN, otherRun],
      getLatestRunForSession: async ({ hostSessionId }: { hostSessionId: string }) => {
        runReads += 1
        return hostSessionId === otherSession.hostSessionId ? otherRun : RUN
      },
    } as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    expect(sent.filter((entry) => entry.type === 'hrc_event').map((entry) => entry.hrcSeq)).toEqual(
      [2, 3, 4]
    )
    expect(
      sent
        .filter((entry) => entry.type === 'session_updated')
        .map((entry) => ({
          hrcSeq: entry.hrcSeq,
          hostSessionId: (entry.session as Record<string, unknown>).hostSessionId,
        }))
    ).toEqual([
      { hrcSeq: 4, hostSessionId: SESSION.hostSessionId },
      { hrcSeq: 3, hostSessionId: otherSession.hostSessionId },
    ])
    expect(runReads).toBe(2)
  })

  test('T-11794: a live event for an unlisted session sends its event but no summary and skips other HRC reads', async () => {
    const hrcEvents = [event(1), event(2)]
    const baseClient = createDashboardClient(hrcEvents)
    let live = false
    const reads = { sessions: 0, runtimes: 0, latest: 0, run: 0 }
    const client = {
      ...baseClient,
      listSessions: async (...args: Parameters<AcpHrcClient['listSessions']>) => {
        if (live) {
          reads.sessions += 1
          return []
        }
        return baseClient.listSessions(...args)
      },
      listRuntimes: async (...args: Parameters<AcpHrcClient['listRuntimes']>) => {
        if (live) reads.runtimes += 1
        return baseClient.listRuntimes(...args)
      },
      listLatestEventBySession: async () => {
        if (live) reads.latest += 1
        return [hrcEvents[0]!]
      },
      getLatestRunForSession: async (
        ...args: Parameters<AcpHrcClient['getLatestRunForSession']>
      ) => {
        if (live) reads.run += 1
        return baseClient.getLatestRunForSession(...args)
      },
      watch: (options: Parameters<AcpHrcClient['watch']>[0]) => {
        live = options?.follow === true
        return baseClient.watch(options)
      },
    } as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    expect(sent.filter((entry) => entry.type === 'hrc_event').map((entry) => entry.hrcSeq)).toEqual(
      [2]
    )
    expect(sent.filter((entry) => entry.type === 'session_updated')).toEqual([])
    expect(reads).toEqual({ sessions: 1, runtimes: 0, latest: 0, run: 0 })
  })

  test('T-11794: an HRC run-read failure during live refresh rejects the dashboard stream instead of being swallowed', async () => {
    const hrcEvents = [event(1), event(2)]
    const baseClient = createDashboardClient(hrcEvents)
    const client = {
      ...baseClient,
      listLatestEventBySession: async () => [hrcEvents[0]!],
      getLatestRunForSession: async () => {
        throw new Error('hrc went away')
      },
    } as AcpHrcClient
    const { ws } = createDashboardSocket({ hrcClient: client })

    await expect(openMobileWebSocket(ws)).rejects.toThrow('hrc went away')
  })

  test('emits replay_gap_too_large and closes when replay count exceeds policy', async () => {
    process.env['ACP_MOBILE_DASHBOARD_MAX_REPLAY_EVENTS'] = '2'
    const { ws, sent, closed } = createDashboardSocket({
      hrcClient: createDashboardClient([event(1), event(2), event(3), event(4)]),
      url: 'http://acp.local/v1/mobile/dashboard?fromHrcSeq=1',
    })

    await openMobileWebSocket(ws)

    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'replay_gap_too_large' })])
    expect(closed).toEqual([{ code: 1008, reason: 'replay gap too large' }])
  })

  test('responds to dashboard ping messages with pong and aborts on close', () => {
    const { ws, sent } = createDashboardSocket({
      hrcClient: createDashboardClient([]),
    })

    handleMobileWebSocketMessage(ws, JSON.stringify({ type: 'ping', id: 'client-ping-1' }))
    expect(sent).toEqual([expect.objectContaining({ type: 'pong', id: 'client-ping-1' })])

    closeMobileWebSocket(ws)
    expect(ws.data.abortController.signal.aborted).toBe(true)
  })

  test('a socket whose send throws does not reject the dashboard stream', async () => {
    const { ws } = createDashboardSocket({ hrcClient: createDashboardClient([event(1), event(2)]) })
    let sendAttempts = 0
    ws.send = () => {
      sendAttempts += 1
      throw new Error('socket closed')
    }

    await openMobileWebSocket(ws)

    expect(sendAttempts).toBeGreaterThan(0)
  })

  test('closing a socket whose abort controller is already disposed does not throw', () => {
    const { ws } = createDashboardSocket({ hrcClient: createDashboardClient([]) })
    ws.data.abortController = {
      abort() {
        throw new Error('already disposed')
      },
      signal: new AbortController().signal,
    } as unknown as AbortController

    expect(() => closeMobileWebSocket(ws)).not.toThrow()
  })
})

describe('WS /v1/mobile/sessions/:hostSessionId/diagnostics', () => {
  test.each([
    { query: '', expected: { fromSeq: 1 }, absent: ['generation'] },
    { query: '?fromHrcSeq=0', expected: { fromSeq: 1 }, absent: ['generation'] },
    { query: '?fromHrcSeq=7&generation=12', expected: { fromSeq: 7, generation: 12 }, absent: [] },
    { query: '?generation=abc', expected: { fromSeq: 1 }, absent: ['generation'] },
    // The path hostSessionId and live follow always win over query values.
    {
      query: '?follow=false&hostSessionId=hsid-query',
      expected: { fromSeq: 1 },
      absent: ['generation'],
    },
  ])(
    'diagnostics watches HRC live from the clamped fromHrcSeq for the path session: "$query"',
    async ({ query, expected, absent }) => {
      const watched: Array<Record<string, unknown>> = []
      const client = {
        watch: (options: Record<string, unknown>) => {
          watched.push(options)
          return (async function* () {})()
        },
      } as unknown as AcpHrcClient
      const { ws, sent } = createDashboardSocket({
        hrcClient: client,
        url: `http://acp.local/v1/mobile/sessions/hsid-diagnostics/diagnostics${query}`,
        kind: 'diagnostics',
        hostSessionId: 'hsid-diagnostics',
      })

      await openMobileWebSocket(ws)

      expect(sent).toEqual([])
      expect(watched).toHaveLength(1)
      expect(watched[0]).toMatchObject({
        ...expected,
        hostSessionId: 'hsid-diagnostics',
        follow: true,
      })
      for (const key of absent) {
        expect(key in watched[0]!).toBe(false)
      }
    }
  )
})

// T-08575: retained rows advance the event cursor but never replace the
// runtime-derived current-activity timestamp.
describe('T-08575 dashboard freshness retained-origin fence', () => {
  for (const fixture of [
    {
      id: 'T6 retained historical latest',
      eventTs: '2026-09-16T08:00:00.000Z',
      evidenceOrigin: 'retained' as const,
      expected: 'runtime',
    },
    {
      id: 'T6 C ordinary historical latest',
      eventTs: '2026-09-16T08:00:00.000Z',
      evidenceOrigin: undefined,
      expected: 'event',
    },
    {
      id: 'T6b retained fresh latest',
      eventTs: '2026-09-16T10:00:00.000Z',
      evidenceOrigin: 'retained' as const,
      expected: 'runtime',
    },
    {
      id: 'T6b C ordinary fresh latest',
      eventTs: '2026-09-16T10:00:00.000Z',
      evidenceOrigin: undefined,
      expected: 'event',
    },
  ]) {
    test(`${fixture.id} keeps cursor progression separate from current activity`, async () => {
      const runtimeLastActivityAt = '2026-09-16T09:00:00.000Z'
      const latest = {
        ...event(85, { ts: fixture.eventTs }),
        ...(fixture.evidenceOrigin !== undefined ? { evidenceOrigin: fixture.evidenceOrigin } : {}),
      } as HrcLifecycleEvent & { evidenceOrigin?: 'retained' }
      const client = createDashboardClient([latest])
      client.listRuntimes = async () => [
        { ...RUNTIME, lastActivityAt: runtimeLastActivityAt } as HrcRuntimeSnapshot,
      ]
      client.listLatestEventBySession = async () => [latest]
      const { ws, sent } = createDashboardSocket({ hrcClient: client })

      await openMobileWebSocket(ws)

      const sessions = sent[0]?.sessions as Array<Record<string, unknown>>
      expect(sessions[0]?.lastHrcSeq).toBe(85)
      expect(sessions[0]?.lastActivityAt).toBe(
        fixture.expected === 'runtime' ? runtimeLastActivityAt : fixture.eventTs
      )
    })
  }
})
