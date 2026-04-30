import { describe, expect, it } from 'bun:test'
import type { HrcRuntimeSnapshot, HrcSessionRecord, HrcTargetView } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import { createSessionIndex } from '../session-index.js'

// ---------------------------------------------------------------------------
// Helpers to build fake HRC records
// ---------------------------------------------------------------------------

let idCounter = 0
function nextId(): string {
  return `id-${++idCounter}`
}

function makeSession(overrides: Partial<HrcSessionRecord> = {}): HrcSessionRecord {
  const hostSessionId = overrides.hostSessionId ?? nextId()
  return {
    hostSessionId,
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: '2026-04-29T00:00:00Z',
    updatedAt: '2026-04-29T00:00:00Z',
    ancestorScopeRefs: ['agent:cody', 'agent:cody:project:agent-spaces'],
    ...overrides,
  }
}

function makeRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: nextId(),
    hostSessionId: nextId(),
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'running',
    supportsInflightInput: true,
    adopted: false,
    createdAt: '2026-04-29T00:00:00Z',
    updatedAt: '2026-04-29T00:01:00Z',
    lastActivityAt: '2026-04-29T00:01:00Z',
    ...overrides,
  }
}

function _makeTarget(overrides: Partial<HrcTargetView> = {}): HrcTargetView {
  return {
    sessionRef: 'agent:cody:project:agent-spaces/lane:main',
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    state: 'bound',
    capabilities: {
      state: 'bound',
      modesSupported: ['headless', 'nonInteractive'],
      defaultMode: 'headless',
      dmReady: true,
      sendReady: true,
      peekReady: true,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fake HrcClient
// ---------------------------------------------------------------------------

type FakeHrcData = {
  sessions?: HrcSessionRecord[]
  runtimes?: HrcRuntimeSnapshot[]
  targets?: HrcTargetView[]
}

function createFakeClient(data: FakeHrcData = {}): HrcClient {
  return {
    listSessions: async () => data.sessions ?? [],
    listRuntimes: async () => data.runtimes ?? [],
    listTargets: async () => data.targets ?? [],
  } as unknown as HrcClient
}

// ---------------------------------------------------------------------------
// Tests: GET /v1/sessions
// ---------------------------------------------------------------------------

describe('GET /v1/sessions', () => {
  it('returns empty index when no sessions', async () => {
    const index = createSessionIndex({ client: createFakeClient() })
    const result = await index.handleListSessions({})

    expect(result.refreshedAt).toBeTruthy()
    expect(result.counts).toEqual({
      all: 0,
      interactive: 0,
      headless: 0,
      active: 0,
      stale: 0,
      inactive: 0,
    })
    expect(result.sessions).toEqual([])
  })

  it('merges session + runtime into MobileSessionSummary', async () => {
    const session = makeSession({ hostSessionId: 'host-1' })
    const runtime = makeRuntime({
      hostSessionId: 'host-1',
      runtimeId: 'rt-1',
      activeRunId: 'run-1',
      lastActivityAt: '2026-04-29T01:00:00Z',
    })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session], runtimes: [runtime] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions).toHaveLength(1)
    const s = result.sessions[0]!
    expect(s.sessionRef).toBe('agent:cody:project:agent-spaces/lane:main')
    expect(s.displayRef).toBe('cody@agent-spaces')
    expect(s.title).toBe('cody')
    expect(s.mode).toBe('interactive')
    expect(s.executionMode).toBe('interactive')
    expect(s.status).toBe('active')
    expect(s.hostSessionId).toBe('host-1')
    expect(s.generation).toBe(1)
    expect(s.runtimeId).toBe('rt-1')
    expect(s.activeTurnId).toBe('run-1')
    expect(s.lastActivityAt).toBe('2026-04-29T01:00:00Z')
  })

  it('emits one row per hostSessionId generation for the same sessionRef', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'host-gen-1', generation: 1 }),
      makeSession({ hostSessionId: 'host-gen-2', generation: 2 }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.map((s) => [s.sessionRef, s.hostSessionId, s.generation])).toEqual([
      ['agent:cody:project:agent-spaces/lane:main', 'host-gen-1', 1],
      ['agent:cody:project:agent-spaces/lane:main', 'host-gen-2', 2],
    ])
  })

  it('derives mode=headless for headless executionMode', async () => {
    const session = makeSession({
      hostSessionId: 'host-h',
      lastAppliedIntentJson: {
        placement: { nodeId: 'local' },
        harness: { harness: 'claude-code', provider: 'anthropic' },
        execution: { preferredMode: 'headless' },
      },
    })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.mode).toBe('headless')
    expect(result.sessions[0]!.executionMode).toBe('headless')
  })

  it('derives mode=headless for nonInteractive executionMode', async () => {
    const session = makeSession({
      hostSessionId: 'host-ni',
      lastAppliedIntentJson: {
        placement: { nodeId: 'local' },
        harness: { harness: 'claude-code', provider: 'anthropic' },
        execution: { preferredMode: 'nonInteractive' },
      },
    })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.mode).toBe('headless')
    expect(result.sessions[0]!.executionMode).toBe('nonInteractive')
  })

  it('derives status=inactive when no runtime', async () => {
    const session = makeSession({ hostSessionId: 'host-no-rt' })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.status).toBe('inactive')
  })

  it('derives status=stale on generation mismatch', async () => {
    const session = makeSession({ hostSessionId: 'host-stale', generation: 3 })
    const runtime = makeRuntime({ hostSessionId: 'host-stale', generation: 2 })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session], runtimes: [runtime] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.status).toBe('stale')
  })

  it('derives status=inactive when runtime is terminated', async () => {
    const session = makeSession({ hostSessionId: 'host-term' })
    const runtime = makeRuntime({ hostSessionId: 'host-term', status: 'terminated' })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session], runtimes: [runtime] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.status).toBe('inactive')
  })

  // -- Counts --

  it('computes counts matching mode buckets', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'h1' }),
      makeSession({ hostSessionId: 'h2' }),
      makeSession({
        hostSessionId: 'h3',
        lastAppliedIntentJson: {
          placement: { nodeId: 'local' },
          harness: { harness: 'claude-code', provider: 'anthropic' },
          execution: { preferredMode: 'headless' },
        },
      }),
    ]
    const runtimes = [makeRuntime({ hostSessionId: 'h1' })]

    const index = createSessionIndex({
      client: createFakeClient({ sessions, runtimes }),
    })
    const result = await index.handleListSessions({})

    expect(result.counts.all).toBe(3)
    expect(result.counts.interactive).toBe(2)
    expect(result.counts.headless).toBe(1)
    expect(result.counts.active).toBe(1) // h1 has runtime
    expect(result.counts.inactive).toBe(2) // h2, h3 have no runtime
  })

  // -- Mode filter --

  it('mode=interactive narrows to interactive sessions', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'h-int' }),
      makeSession({
        hostSessionId: 'h-head',
        lastAppliedIntentJson: {
          placement: { nodeId: 'local' },
          harness: { harness: 'claude-code', provider: 'anthropic' },
          execution: { preferredMode: 'headless' },
        },
      }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ mode: 'interactive' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.mode).toBe('interactive')
    expect(result.counts.all).toBe(1)
    expect(result.counts.interactive).toBe(1)
    expect(result.counts.headless).toBe(0)
  })

  it('mode=headless narrows to headless sessions', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'h-int2' }),
      makeSession({
        hostSessionId: 'h-head2',
        lastAppliedIntentJson: {
          placement: { nodeId: 'local' },
          harness: { harness: 'claude-code', provider: 'anthropic' },
          execution: { preferredMode: 'headless' },
        },
      }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ mode: 'headless' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.mode).toBe('headless')
  })

  // -- Status filter --

  it('status=active narrows to active sessions', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'h-active' }),
      makeSession({ hostSessionId: 'h-inactive' }),
    ]
    const runtimes = [makeRuntime({ hostSessionId: 'h-active' })]

    const index = createSessionIndex({
      client: createFakeClient({ sessions, runtimes }),
    })
    const result = await index.handleListSessions({ status: 'active' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.status).toBe('active')
  })

  // -- q filter --

  it('q filter does case-insensitive substring match on title', async () => {
    const sessions = [
      makeSession({
        hostSessionId: 'hq1',
        scopeRef: 'agent:alice:project:demo',
      }),
      makeSession({
        hostSessionId: 'hq2',
        scopeRef: 'agent:bob:project:demo',
      }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ q: 'ALICE' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.title).toBe('alice')
  })

  it('q filter matches on sessionRef', async () => {
    const sessions = [
      makeSession({
        hostSessionId: 'hq-ref',
        scopeRef: 'agent:cody:project:agent-spaces',
      }),
      makeSession({
        hostSessionId: 'hq-ref2',
        scopeRef: 'agent:larry:project:wrkq',
      }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ q: 'wrkq' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.title).toBe('larry')
  })

  it('q filter matches on displayRef', async () => {
    const sessions = [
      makeSession({
        hostSessionId: 'hq-display',
        scopeRef: 'agent:cody:project:agent-spaces',
      }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ q: 'cody@agent' })

    expect(result.sessions).toHaveLength(1)
  })

  it('counts reflect mode bucket, not q filter', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'hc1', scopeRef: 'agent:alice:project:demo' }),
      makeSession({ hostSessionId: 'hc2', scopeRef: 'agent:bob:project:demo' }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions }),
    })
    const result = await index.handleListSessions({ q: 'alice' })

    // q filters the sessions list but counts are computed before q
    expect(result.sessions).toHaveLength(1)
    expect(result.counts.all).toBe(2) // counts unaffected by q
    expect(result.counts.interactive).toBe(2)
  })

  // -- Deterministic order --

  it('sorts by lastActivityAt desc (most recent first), nulls last', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'h-old' }),
      makeSession({ hostSessionId: 'h-new' }),
      makeSession({ hostSessionId: 'h-null' }),
    ]
    const runtimes = [
      makeRuntime({ hostSessionId: 'h-old', lastActivityAt: '2026-04-29T00:00:00Z' }),
      makeRuntime({ hostSessionId: 'h-new', lastActivityAt: '2026-04-29T01:00:00Z' }),
    ]

    const index = createSessionIndex({
      client: createFakeClient({ sessions, runtimes }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.hostSessionId).toBe('h-new')
    expect(result.sessions[1]!.hostSessionId).toBe('h-old')
    expect(result.sessions[2]!.hostSessionId).toBe('h-null')
  })

  // -- Capabilities --

  it('sets input=true for active interactive sessions with inflight support', async () => {
    const session = makeSession({ hostSessionId: 'h-cap' })
    const runtime = makeRuntime({
      hostSessionId: 'h-cap',
      supportsInflightInput: true,
    })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session], runtimes: [runtime] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.capabilities.input).toBe(true)
    expect(result.sessions[0]!.capabilities.interrupt).toBe(true)
    expect(result.sessions[0]!.capabilities.launchHeadlessTurn).toBe(false)
    expect(result.sessions[0]!.capabilities.history).toBe(true)
  })

  it('sets launchHeadlessTurn=true for active headless sessions', async () => {
    const session = makeSession({
      hostSessionId: 'h-cap-head',
      lastAppliedIntentJson: {
        placement: { nodeId: 'local' },
        harness: { harness: 'claude-code', provider: 'anthropic' },
        execution: { preferredMode: 'headless' },
      },
    })
    const runtime = makeRuntime({ hostSessionId: 'h-cap-head' })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session], runtimes: [runtime] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.capabilities.launchHeadlessTurn).toBe(true)
    expect(result.sessions[0]!.capabilities.input).toBe(false)
    expect(result.sessions[0]!.capabilities.interrupt).toBe(false)
  })

  it('sets all capabilities false (except history) for inactive sessions', async () => {
    const session = makeSession({ hostSessionId: 'h-cap-inactive' })

    const index = createSessionIndex({
      client: createFakeClient({ sessions: [session] }),
    })
    const result = await index.handleListSessions({})

    expect(result.sessions[0]!.capabilities.input).toBe(false)
    expect(result.sessions[0]!.capabilities.interrupt).toBe(false)
    expect(result.sessions[0]!.capabilities.launchHeadlessTurn).toBe(false)
    expect(result.sessions[0]!.capabilities.history).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /v1/sessions/refresh
// ---------------------------------------------------------------------------

describe('POST /v1/sessions/refresh', () => {
  it('re-queries HRC and reflects updated state', async () => {
    let callCount = 0
    const client = {
      listSessions: async () => {
        callCount++
        if (callCount === 1) {
          return [makeSession({ hostSessionId: 'h-before' })]
        }
        return [
          makeSession({ hostSessionId: 'h-before' }),
          makeSession({ hostSessionId: 'h-after' }),
        ]
      },
      listRuntimes: async () => [],
      listTargets: async () => [],
    } as unknown as HrcClient

    const index = createSessionIndex({ client })

    // First call
    const first = await index.handleListSessions({})
    expect(first.sessions).toHaveLength(1)

    // Refresh bypasses cache
    const refreshed = await index.handleRefresh({})
    expect(refreshed.sessions).toHaveLength(2)
  })

  it('applies filters on refresh result', async () => {
    const sessions = [
      makeSession({ hostSessionId: 'hr1', scopeRef: 'agent:alice:project:demo' }),
      makeSession({
        hostSessionId: 'hr2',
        scopeRef: 'agent:bob:project:demo',
        lastAppliedIntentJson: {
          placement: { nodeId: 'local' },
          harness: { harness: 'claude-code', provider: 'anthropic' },
          execution: { preferredMode: 'headless' },
        },
      }),
    ]

    const client = createFakeClient({ sessions })
    const index = createSessionIndex({ client })
    const result = await index.handleRefresh({ mode: 'interactive', q: 'alice' })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]!.title).toBe('alice')
  })
})
