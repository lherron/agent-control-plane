import { describe, expect, test } from 'bun:test'
import { redactPayload } from 'acp-ops-projection'
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

  test('selectVisibleEvents applies every filter arm and preserves timestamp ordering', () => {
    const events = [
      baseEvent({
        hrcSeq: 201,
        ts: '2026-04-23T23:46:00.000Z',
        sessionRef: { scopeRef: 'agent:larry', laneRef: 'main' },
        hostSessionId: 'host-a',
        runtimeId: 'runtime-a',
        runId: 'run-a',
        family: 'runtime',
        severity: 'info',
        label: 'Larry runtime',
      }),
      baseEvent({
        hrcSeq: 202,
        ts: '2026-04-23T23:47:00.000Z',
        sessionRef: { scopeRef: 'agent:daedalus', laneRef: 'main' },
        hostSessionId: 'host-b',
        runtimeId: 'runtime-b',
        runId: 'run-b',
        family: 'tool',
        severity: 'warning',
        label: 'Daedalus tool',
      }),
      baseEvent({
        hrcSeq: 203,
        ts: '2026-04-23T23:48:00.000Z',
        sessionRef: { scopeRef: 'agent:larry', laneRef: 'aux' },
        hostSessionId: 'host-c',
        runtimeId: 'runtime-a',
        runId: 'run-c',
        family: 'input',
        severity: 'error',
        label: 'Larry input',
      }),
      baseEvent({
        hrcSeq: 204,
        ts: '2026-04-23T23:49:00.000Z',
        sessionRef: { scopeRef: 'agent:larry', laneRef: 'main' },
        hostSessionId: 'host-a',
        runtimeId: 'runtime-c',
        family: 'delivery',
        severity: 'success',
        label: 'Larry delivery',
      }),
    ]
    const state = events.reduce((current, event) => applyEvent(current, event), initialState())
    const visibleIds = (filters: Parameters<typeof selectVisibleEvents>[1]) =>
      selectVisibleEvents(state, filters).map((event) => event.id)

    expect(visibleIds({})).toEqual(['hrc:201', 'hrc:202', 'hrc:203', 'hrc:204'])
    expect(visibleIds({ scopeRef: 'agent:larry' })).toEqual(['hrc:201', 'hrc:203', 'hrc:204'])
    expect(visibleIds({ laneRef: 'main' })).toEqual(['hrc:201', 'hrc:202', 'hrc:204'])
    expect(visibleIds({ hostSessionId: 'host-a' })).toEqual(['hrc:201', 'hrc:204'])
    expect(visibleIds({ runtimeId: 'runtime-a' })).toEqual(['hrc:201', 'hrc:203'])
    expect(visibleIds({ runId: 'run-b' })).toEqual(['hrc:202'])
    expect(visibleIds({ family: 'input' })).toEqual(['hrc:203'])
    expect(visibleIds({ severity: 'warning' })).toEqual(['hrc:202'])
    expect(visibleIds({ fromTs: '2026-04-23T23:47:00.000Z' })).toEqual([
      'hrc:202',
      'hrc:203',
      'hrc:204',
    ])
    expect(visibleIds({ toTs: '2026-04-23T23:48:00.000Z' })).toEqual([
      'hrc:201',
      'hrc:202',
      'hrc:203',
    ])
    expect(
      visibleIds({
        scopeRef: 'agent:larry',
        laneRef: 'main',
        hostSessionId: 'host-a',
        runtimeId: 'runtime-c',
        family: 'delivery',
        severity: 'success',
        fromTs: '2026-04-23T23:48:30.000Z',
        toTs: '2026-04-23T23:49:30.000Z',
      })
    ).toEqual(['hrc:204'])
    expect(visibleIds({ scopeRef: 'agent:missing' })).toEqual([])
    expect(visibleIds({ fromTs: 'not-a-date', toTs: 'also-not-a-date' })).toEqual([
      'hrc:201',
      'hrc:202',
      'hrc:203',
      'hrc:204',
    ])
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
    const sample = {
      token: 'raw-token',
      nested: { secret: 'raw-secret' },
      rawProviderPayload: { visible: false },
      safe: 'visible',
    }
    const state = applyEvent(
      initialState(),
      baseEvent({
        hrcSeq: 101,
        payloadPreview: sample,
        redacted: false,
      })
    )

    expect(state.events.get('hrc:101')?.payloadPreview).toEqual(
      redactPayload(sample).payloadPreview
    )
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
