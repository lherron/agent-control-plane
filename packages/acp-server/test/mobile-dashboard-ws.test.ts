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
    listRuntimes: async () => [RUNTIME],
    listLatestEventBySession: async () => [events.at(-1)].filter(Boolean) as HrcLifecycleEvent[],
    getLatestRunForSession: async () => RUN,
    listRuns: async () => [RUN],
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
      kind: 'dashboard',
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

describe('WS /v1/mobile/dashboard', () => {
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
