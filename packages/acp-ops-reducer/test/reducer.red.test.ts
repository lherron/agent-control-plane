import { describe, expect, test } from 'bun:test'
import type { DashboardEvent, ReducerState } from '../src/index.js'
import {
  applyEvent,
  compact,
  parseNdjsonChunk,
  reconnect,
  selectSortedRows,
  selectVisibleEvents,
  setWindow,
} from '../src/index.js'

const baseEvent = (overrides: Partial<DashboardEvent> = {}): DashboardEvent => {
  const hrcSeq = overrides.hrcSeq ?? 100

  return {
    id: `hrc:${hrcSeq}`,
    hrcSeq,
    ts: '2026-04-23T23:46:51.000Z',
    sessionRef: {
      scopeRef: 'project:agent-spaces',
      laneRef: 'main',
    },
    hostSessionId: 'host-session-1',
    generation: 1,
    eventKind: 'runtime.status',
    family: 'runtime',
    severity: 'info',
    label: 'Runtime status',
    redacted: true,
    ...overrides,
  }
}

const initialState = (): ReducerState => ({
  rows: new Map(),
  events: new Map(),
  lastProcessedHrcSeq: 0,
  droppedEvents: 0,
  reconnectCount: 0,
  window: {
    fromTs: '2026-04-23T23:45:00.000Z',
    toTs: '2026-04-23T23:50:00.000Z',
    windowMs: 300_000,
  },
})

describe('session dashboard reducer red contract', () => {
  test('ordered replay produces rows, visible events, and durable hrcSeq cursor', () => {
    // SESSION_DASHBOARD.md §10.3 + §12 + §19.1: replay order is hrcSeq order.
    const events = [
      baseEvent({ hrcSeq: 1, eventKind: 'runtime.launching', label: 'Launching' }),
      baseEvent({ hrcSeq: 2, eventKind: 'runtime.busy', label: 'Busy' }),
      baseEvent({ hrcSeq: 3, eventKind: 'message.end', family: 'agent_message', label: 'Done' }),
    ]

    const state = events.reduce((current, event) => applyEvent(current, event), initialState())

    expect(state.lastProcessedHrcSeq).toBe(3)
    expect(selectVisibleEvents(state, {}).map((event) => event.id)).toEqual([
      'hrc:1',
      'hrc:2',
      'hrc:3',
    ])
    expect(selectSortedRows(state).map((row) => row.rowId)).toEqual(['host-session-1:1'])
  })

  test('duplicate event idempotency is a no-op after the first application', () => {
    // SESSION_DASHBOARD.md §12: applying the same event twice is idempotent.
    const event = baseEvent({ hrcSeq: 10, label: 'Only once' })
    const once = applyEvent(initialState(), event)
    const twice = applyEvent(once, event)

    expect(twice).toEqual(once)
    expect(selectVisibleEvents(twice, {}).map((visible) => visible.id)).toEqual(['hrc:10'])
  })

  test('dedupes stable event id across replay after live ingestion', () => {
    // SESSION_DASHBOARD.md §10.3: reconnect replay may include the last processed event.
    const live = applyEvent(initialState(), baseEvent({ hrcSeq: 41, label: 'Live event' }))
    const replayed = applyEvent(live, baseEvent({ hrcSeq: 41, label: 'Replayed duplicate' }))

    expect(replayed.events.size).toBe(1)
    expect(replayed.lastProcessedHrcSeq).toBe(41)
    expect(selectVisibleEvents(replayed, {})[0]?.label).toBe('Live event')
  })

  test('malformed NDJSON recovery drops bad complete lines and preserves clean remainder', () => {
    // SESSION_DASHBOARD.md §12 + §19.1: parse incrementally and skip malformed lines.
    const valid = baseEvent({ hrcSeq: 51, label: 'Valid line' })
    const chunk = `\n${JSON.stringify(valid)}\n{bad json}\n${JSON.stringify(
      baseEvent({ hrcSeq: 52 })
    ).slice(0, 20)}`

    expect(parseNdjsonChunk(chunk)).toEqual({
      events: [valid],
      remainder: JSON.stringify(baseEvent({ hrcSeq: 52 })).slice(0, 20),
      droppedLines: 1,
    })
  })

  test('equal timestamp ordering falls back to hrcSeq within a row', () => {
    // SESSION_DASHBOARD.md §10: same-row ordering sorts by ts then hrcSeq.
    const state = [
      baseEvent({ hrcSeq: 62, ts: '2026-04-23T23:46:51.000Z', label: 'Second' }),
      baseEvent({ hrcSeq: 61, ts: '2026-04-23T23:46:51.000Z', label: 'First' }),
    ].reduce((current, event) => applyEvent(current, event), initialState())

    expect(selectVisibleEvents(state, {}).map((event) => event.id)).toEqual(['hrc:61', 'hrc:62'])
  })

  test('generation rotation creates a new row and preserves prior generation history', () => {
    // SESSION_DASHBOARD.md §12: clear_context/generation changes must not rewrite old rows.
    const state = [
      baseEvent({ hrcSeq: 70, generation: 1, eventKind: 'message.end', label: 'Old generation' }),
      baseEvent({
        hrcSeq: 71,
        generation: 2,
        eventKind: 'clear_context',
        family: 'context',
        label: 'Context cleared',
      }),
    ].reduce((current, event) => applyEvent(current, event), initialState())

    expect(selectSortedRows(state).map((row) => row.rowId)).toEqual([
      'host-session-1:1',
      'host-session-1:2',
    ])
    expect(selectSortedRows(state)[0]?.visualState.continuity).toBe('blocked')
  })

  test('stale-context rejection remains visible after newer generation succeeds', () => {
    // SESSION_DASHBOARD.md §12 + §19.1: stale-context warnings stay visible.
    const state = [
      baseEvent({
        hrcSeq: 80,
        generation: 1,
        eventKind: 'context.stale_rejected',
        family: 'warning',
        severity: 'warning',
        label: 'Stale context rejected',
      }),
      baseEvent({
        hrcSeq: 81,
        generation: 2,
        eventKind: 'message.end',
        family: 'agent_message',
        severity: 'success',
        label: 'New generation succeeded',
      }),
    ].reduce((current, event) => applyEvent(current, event), initialState())

    expect(selectVisibleEvents(state, { severity: 'warning' }).map((event) => event.label)).toEqual(
      ['Stale context rejected']
    )
  })

  test('in-flight accepted and queued paths branch, applied rejoins, and rejected stays visible', () => {
    // SESSION_DASHBOARD.md §19.1: accepted/rejected/applied in-flight input paths are visible.
    const state = [
      baseEvent({ hrcSeq: 90, eventKind: 'inflight.accepted', family: 'input', label: 'Accepted' }),
      baseEvent({
        hrcSeq: 91,
        eventKind: 'user_input_queued_in_flight',
        family: 'input',
        label: 'Queued branch',
      }),
      baseEvent({
        hrcSeq: 92,
        eventKind: 'user_input_applied_in_flight',
        family: 'input',
        severity: 'success',
        label: 'Rejoined',
      }),
      baseEvent({
        hrcSeq: 93,
        eventKind: 'inflight.rejected',
        family: 'input',
        severity: 'warning',
        label: 'Rejected',
      }),
    ].reduce((current, event) => applyEvent(current, event), initialState())

    const [row] = selectSortedRows(state)
    expect(row?.acp?.inputAttemptId).toBeUndefined()
    expect(selectVisibleEvents(state, { severity: 'warning' }).map((event) => event.label)).toEqual(
      ['Rejected']
    )
  })

  test('payload redaction happens before reducer state or selectors expose events', () => {
    // SESSION_DASHBOARD.md §12 + §16: reducer state must not hold raw payload previews.
    const state = applyEvent(
      initialState(),
      baseEvent({
        hrcSeq: 101,
        payloadPreview: {
          token: 'raw-token',
          nested: { secret: 'raw-secret' },
          safe: 'visible',
        },
        redacted: false,
      })
    )

    expect(state.events.get('hrc:101')?.payloadPreview).toEqual({
      token: '[REDACTED]',
      nested: { secret: '[REDACTED]' },
      safe: 'visible',
    })
    expect(selectVisibleEvents(state, {})[0]?.redacted).toBe(true)
  })

  test('bounded-window compaction removes old events and preserves durable cursor', () => {
    // SESSION_DASHBOARD.md §12 + §15: compaction must not lose replay cursor.
    const loaded = [
      baseEvent({ hrcSeq: 110, ts: '2026-04-23T23:40:00.000Z', label: 'Old' }),
      baseEvent({ hrcSeq: 111, ts: '2026-04-23T23:49:00.000Z', label: 'Current' }),
    ].reduce((current, event) => applyEvent(current, event), initialState())
    const windowed = setWindow(loaded, 300_000, '2026-04-23T23:50:00.000Z')
    const compacted = compact(windowed)

    expect(selectVisibleEvents(compacted, {}).map((event) => event.id)).toEqual(['hrc:111'])
    expect(compacted.lastProcessedHrcSeq).toBe(111)
  })

  test('reconnect preserves durable cursor and increments reconnect count', () => {
    // SESSION_DASHBOARD.md §10.3 + §18: reconnect resumes from lastProcessedHrcSeq + 1.
    const state = applyEvent(initialState(), baseEvent({ hrcSeq: 120 }))
    const reconnecting = reconnect(state)

    expect(reconnecting.lastProcessedHrcSeq).toBe(120)
    expect(reconnecting.reconnectCount).toBe(1)
  })
})
