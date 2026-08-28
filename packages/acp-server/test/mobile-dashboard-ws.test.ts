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
  ancestorScopeRefs: [],
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
  status: 'active',
  tmuxJson: { paneId: 'pane-1' },
  wrapperPid: 111,
  childPid: 222,
  supportsInflightInput: true,
  adopted: false,
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

    expect(sent).toEqual([
      expect.objectContaining({ type: 'error', code: 'remote_control_unavailable' }),
    ])
    expect(closed).toEqual([{ code: 1008, reason: 'remote control unavailable' }])
    expect(listSessionsCalls).toBe(0)
  })
})

describe('WS /v1/mobile/dashboard', () => {
  test('coalesces session freshness reads used by the index and snapshot cursor', async () => {
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
    })
    expect(sessions[0]!.run).toMatchObject({ runId: RUN.runId, status: 'running' })
    expect(JSON.stringify(sessions[0])).not.toContain('wrapperPid')
    expect(JSON.stringify(sessions[0])).not.toContain('childPid')
    expect(JSON.stringify(sessions[0])).not.toContain(LARGE_INITIAL_PROMPT)

    const recent = snapshot.recentEventsBySession as Record<string, SentEnvelope[]>
    const bucket = recent[`${SESSION.hostSessionId}:${SESSION.generation}`]!
    expect(bucket.map((item) => item.hrcSeq)).toEqual([8, 9, 10, 11, 12])
  })

  test('includes heavyweight session internals only when sessionDetails is requested', async () => {
    const { ws, sent } = createDashboardSocket({
      hrcClient: createDashboardClient([event(1)]),
      url: 'http://acp.local/v1/mobile/dashboard?sessionDetails=true',
    })

    await openMobileWebSocket(ws)

    const sessions = (sent[0] as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    const session = sessions[0]!.session as Record<string, unknown>
    expect(session.continuation).toEqual(SESSION.continuation)
    expect(session.lastAppliedIntent).toEqual(SESSION.lastAppliedIntentJson)
    expect(JSON.stringify(session)).toContain(LARGE_INITIAL_PROMPT)
  })

  test('summaryStatus becomes inactive when runtime is dead even if session record is active', async () => {
    const deadRuntime: HrcRuntimeSnapshot = { ...RUNTIME, status: 'terminated' }
    const client = {
      listSessions: async () => [SESSION],
      listRuntimes: async () => [deadRuntime],
      listLatestEventBySession: async () => [event(1)],
      getLatestRunForSession: async () => RUN,
      listRuns: async () => [RUN],
      watch: () => (async function* () {})(),
    } as unknown as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    const sessions = (sent[0] as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    expect(sessions[0]!.summaryStatus).toBe('inactive')
    expect((sessions[0]!.session as Record<string, unknown>).status).toBe('active')
  })

  test('projects a detached external runtime honestly instead of reporting it active', async () => {
    const detachedRuntime: HrcRuntimeSnapshot = {
      ...RUNTIME,
      status: 'detached',
    }
    const client = {
      listSessions: async () => [SESSION],
      listRuntimes: async () => [detachedRuntime],
      listLatestEventBySession: async () => [event(1)],
      getLatestRunForSession: async () => RUN,
      listRuns: async () => [RUN],
      watch: () => (async function* () {})(),
    } as unknown as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    const sessions = (sent[0] as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    expect(sessions[0]!.summaryStatus).toBe('detached')
    expect(sessions[0]!.status).toBe('detached')
    expect(sessions[0]!.runtime).toMatchObject({ status: 'detached' })
  })

  test('summaryStatus is inactive when no runtime is attached', async () => {
    const client = {
      listSessions: async () => [SESSION],
      listRuntimes: async () => [],
      listLatestEventBySession: async () => [event(1)],
      getLatestRunForSession: async () => undefined,
      listRuns: async () => [],
      watch: () => (async function* () {})(),
    } as unknown as AcpHrcClient
    const { ws, sent } = createDashboardSocket({ hrcClient: client })

    await openMobileWebSocket(ws)

    const sessions = (sent[0] as Record<string, unknown>).sessions as Array<Record<string, unknown>>
    expect(sessions[0]!.summaryStatus).toBe('inactive')
  })

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
    const sessionUpdates = sent.filter((envelope) => envelope.type === 'session_updated')
    expect(sessionUpdates).toHaveLength(2)
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
})
