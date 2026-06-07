import { describe, expect, test } from 'bun:test'
import {
  DASHBOARD_WINDOW_MS,
  mobileEventToDashboardEvent,
  mobileSnapshotToDashboardSnapshot,
} from '../mobile-adapter'
import type {
  MobileDashboardSnapshotFrame,
  MobileEventMessage,
} from '../mobile-frames'

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

  test('leaves sessions empty for the reducer to derive', () => {
    const snapshot = mobileSnapshotToDashboardSnapshot(FRAME)
    expect(snapshot.sessions).toEqual([])
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
