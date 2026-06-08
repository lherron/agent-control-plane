import { describe, expect, test } from 'bun:test'
import {
  DASHBOARD_WINDOW_MS,
  isLiveSession,
  mobileEventToDashboardEvent,
  mobileSessionToRow,
  mobileSnapshotToDashboardSnapshot,
  parseSessionRef,
} from '../mobile-adapter'
import type {
  MobileDashboardSnapshotFrame,
  MobileEventMessage,
  MobileSessionSummary,
} from '../mobile-frames'

// Real roster summary captured from /v1/mobile/dashboard (active-but-idle session).
const IDLE_ACTIVE_SESSION: MobileSessionSummary = {
  sessionRef: 'agent:clod:project:agent-control-plane:task:primary/lane:main',
  displayRef: 'agent:clod:project:agent-control-plane:task:primary/lane:main',
  title: 'agent:clod:project:agent-control-plane:task:primary',
  summaryStatus: 'active',
  status: 'active',
  hostSessionId: 'hsid-32ad82e1-322d-4f57-a809-7d7a8074a512',
  generation: 5,
  runtimeId: 'rt-a21c11b6',
  lastHrcSeq: 357510,
  lastActivityAt: '2026-06-07T16:04:56.281Z',
  runtime: {
    status: 'ready',
    transport: 'tmux',
    runtimeId: 'rt-a21c11b6',
    supportsInflightInput: true,
  },
}

// Real frames captured from a live /v1/mobile/dashboard WS (acp-server :18470).
const TURN_MESSAGE: MobileEventMessage = {
  type: 'hrc_event',
  hrcSeq: 356003,
  streamSeq: 6125142,
  eventKind: 'turn.message',
  category: 'turn',
  ts: '2026-06-07T14:24:27.133Z',
  payload: {
    type: 'message_end',
    message: { role: 'assistant', content: 'All gates green on the fixed migration.' },
  },
  scopeRef: 'agent:clod:project:wrkq:task:primary',
  laneRef: 'main',
  sessionRef: 'agent:clod:project:wrkq:task:primary/lane:main',
  hostSessionId: 'hsid-cf58851f-9435-4923-881d-8df93b902681',
  generation: 7,
  runtimeId: 'rt-90d5ce0c-5c44-4e80-a440-eced931711e4',
  runId: 'run-5c265114-abf5-43a6-bf66-ad56fc933a58',
  replayed: false,
}

const TOOL_RESULT: MobileEventMessage = {
  type: 'hrc_event',
  hrcSeq: 356004,
  streamSeq: 6125144,
  eventKind: 'turn.tool_result',
  category: 'turn',
  ts: '2026-06-07T14:24:27.135Z',
  payload: { type: 'tool_execution_end', toolName: 'Bash', isError: false },
  scopeRef: 'agent:clod:project:wrkq:task:primary',
  laneRef: 'main',
  sessionRef: 'agent:clod:project:wrkq:task:primary/lane:main',
  hostSessionId: 'hsid-cf58851f-9435-4923-881d-8df93b902681',
  generation: 7,
  runtimeId: 'rt-90d5ce0c-5c44-4e80-a440-eced931711e4',
  runId: 'run-5c265114-abf5-43a6-bf66-ad56fc933a58',
  replayed: false,
}

describe('mobileEventToDashboardEvent', () => {
  test('maps a real hrc_event frame into a DashboardEvent', () => {
    const event = mobileEventToDashboardEvent(TURN_MESSAGE)
    expect(event).toBeDefined()
    expect(event?.id).toBe('hsid-cf58851f-9435-4923-881d-8df93b902681:356003')
    expect(event?.hrcSeq).toBe(356003)
    expect(event?.sessionRef).toEqual({
      scopeRef: 'agent:clod:project:wrkq:task:primary',
      laneRef: 'main',
    })
    expect(event?.hostSessionId).toBe('hsid-cf58851f-9435-4923-881d-8df93b902681')
    expect(event?.generation).toBe(7)
    expect(event?.runtimeId).toBe('rt-90d5ce0c-5c44-4e80-a440-eced931711e4')
    expect(event?.eventKind).toBe('turn.message')
    // projected fields populated by the projector
    expect(event?.family).toBeDefined()
    expect(event?.severity).toBeDefined()
    expect(event?.label.length).toBeGreaterThan(0)
  })

  test('defaults missing laneRef to main', () => {
    const event = mobileEventToDashboardEvent({ ...TURN_MESSAGE, laneRef: undefined })
    expect(event?.sessionRef.laneRef).toBe('main')
  })

  test('returns undefined when scopeRef is missing', () => {
    expect(mobileEventToDashboardEvent({ ...TURN_MESSAGE, scopeRef: undefined })).toBeUndefined()
  })

  test('returns undefined when hostSessionId is missing', () => {
    expect(
      mobileEventToDashboardEvent({ ...TURN_MESSAGE, hostSessionId: undefined })
    ).toBeUndefined()
  })
})

describe('mobileSnapshotToDashboardSnapshot', () => {
  const FRAME: MobileDashboardSnapshotFrame = {
    type: 'dashboard_snapshot',
    generatedAt: '2026-06-07T14:24:23.863Z',
    cursors: { lastHrcSeq: 356004, lastStreamSeq: 6125144, nextFromHrcSeq: 356005 },
    sessions: [],
    recentEventsBySession: {
      'hsid-cf58851f-9435-4923-881d-8df93b902681': [TOOL_RESULT, TURN_MESSAGE],
    },
  }

  test('flattens recentEventsBySession into events sorted by hrcSeq', () => {
    const snapshot = mobileSnapshotToDashboardSnapshot(FRAME)
    expect(snapshot.events.map((e) => e.hrcSeq)).toEqual([356003, 356004])
  })

  test('maps cursors (nextFromHrcSeq → nextFromSeq)', () => {
    const snapshot = mobileSnapshotToDashboardSnapshot(FRAME)
    expect(snapshot.cursors.nextFromSeq).toBe(356005)
    expect(snapshot.cursors.lastHrcSeq).toBe(356004)
    expect(snapshot.cursors.lastStreamSeq).toBe(6125144)
  })

  test('with an empty roster, sessions is empty', () => {
    const snapshot = mobileSnapshotToDashboardSnapshot(FRAME)
    expect(snapshot.sessions).toEqual([])
  })

  test('populates roster rows for active sessions even with no recent events', () => {
    // Roster carries an active-idle session; recentEventsBySession is empty for it.
    const frame: MobileDashboardSnapshotFrame = {
      ...FRAME,
      sessions: [IDLE_ACTIVE_SESSION],
      recentEventsBySession: {},
    }
    const snapshot = mobileSnapshotToDashboardSnapshot(frame)
    expect(snapshot.events).toEqual([])
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]?.sessionRef.scopeRef).toBe(
      'agent:clod:project:agent-control-plane:task:primary'
    )
    expect(snapshot.sessions[0]?.runtime?.status).toBe('idle')
    // StatusStrip counts reflect the roster (idle session counted)
    expect(snapshot.summary.counts.idle).toBe(1)
  })

  test('derives a summary with a window of DASHBOARD_WINDOW_MS', () => {
    const snapshot = mobileSnapshotToDashboardSnapshot(FRAME)
    expect(snapshot.summary).toBeDefined()
    expect(snapshot.summary.counts).toBeDefined()
    const span = Date.parse(snapshot.window.toTs) - Date.parse(snapshot.window.fromTs)
    expect(span).toBe(DASHBOARD_WINDOW_MS)
  })

  test('skips malformed events without identity fields', () => {
    const frame: MobileDashboardSnapshotFrame = {
      ...FRAME,
      recentEventsBySession: {
        x: [{ ...TURN_MESSAGE, scopeRef: undefined }, TOOL_RESULT],
      },
    }
    const snapshot = mobileSnapshotToDashboardSnapshot(frame)
    expect(snapshot.events.map((e) => e.hrcSeq)).toEqual([356004])
  })
})

describe('parseSessionRef', () => {
  test('splits scope and lane', () => {
    expect(parseSessionRef('agent:clod:project:x:task:primary/lane:main')).toEqual({
      scopeRef: 'agent:clod:project:x:task:primary',
      laneRef: 'main',
    })
  })
  test('defaults lane to main when absent', () => {
    expect(parseSessionRef('agent:clod:project:x')).toEqual({
      scopeRef: 'agent:clod:project:x',
      laneRef: 'main',
    })
  })
})

describe('mobileSessionToRow', () => {
  test('maps an active-idle session to an idle row with identity + lastEventAt', () => {
    const row = mobileSessionToRow(IDLE_ACTIVE_SESSION)
    expect(row).toBeDefined()
    expect(row?.rowId).toBe('hsid-32ad82e1-322d-4f57-a809-7d7a8074a512:5')
    expect(row?.runtime?.status).toBe('idle')
    expect(row?.runtime?.transport).toBe('tmux')
    expect(row?.visualState.continuity).toBe('healthy')
    expect(row?.stats.lastEventAt).toBe('2026-06-07T16:04:56.281Z')
  })

  test('marks busy when a run is running or a turn is active', () => {
    expect(
      mobileSessionToRow({ ...IDLE_ACTIVE_SESSION, run: { status: 'running', runId: 'r1' } })
        ?.runtime?.status
    ).toBe('busy')
    expect(
      mobileSessionToRow({ ...IDLE_ACTIVE_SESSION, activeTurnId: 't1' })?.runtime?.status
    ).toBe('busy')
  })

  test('maps stale summaryStatus to a broken/stale row', () => {
    const row = mobileSessionToRow({ ...IDLE_ACTIVE_SESSION, summaryStatus: 'stale' })
    expect(row?.runtime?.status).toBe('stale')
    expect(row?.visualState.continuity).toBe('broken')
  })

  test('returns undefined without identity fields', () => {
    expect(mobileSessionToRow({ ...IDLE_ACTIVE_SESSION, hostSessionId: '' })).toBeUndefined()
  })
})

describe('isLiveSession', () => {
  test('keeps active only; drops stale and inactive (avoids historical-cruft flood)', () => {
    expect(isLiveSession(IDLE_ACTIVE_SESSION)).toBe(true)
    expect(isLiveSession({ ...IDLE_ACTIVE_SESSION, summaryStatus: 'stale' })).toBe(false)
    expect(isLiveSession({ ...IDLE_ACTIVE_SESSION, summaryStatus: 'inactive' })).toBe(false)
  })
})
