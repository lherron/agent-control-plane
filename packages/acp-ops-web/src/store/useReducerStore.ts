import type {
  DashboardEvent,
  SessionDashboardSnapshot,
  SessionDashboardSummary,
  SessionTimelineRow,
} from 'acp-ops-projection'
import {
  type ReducerState,
  applyEvent,
  compact,
  reconnect,
  selectSortedRows,
  selectVisibleEvents,
} from 'acp-ops-reducer'
import { create } from 'zustand'
import { createEmptyDashboardSnapshot } from '../api/snapshot'
import type { StreamConnectionState } from '../api/stream'

export type DashboardReducerState = {
  snapshot: SessionDashboardSnapshot
  reducer: ReducerState
  rows: SessionTimelineRow[]
  events: DashboardEvent[]
  summary: SessionDashboardSummary
  connectionState: StreamConnectionState
  selectedEventId?: string | undefined
  selectedRowId?: string | undefined
  lastHeartbeatAt?: string | undefined
  gapFromSeq?: number | undefined
  familyFilter: DashboardEvent['family'] | 'all'
}

export type DashboardReducerAction =
  | { type: 'snapshot.loaded'; snapshot: SessionDashboardSnapshot }
  | { type: 'event.received'; event: DashboardEvent }
  | { type: 'event.selected'; eventId: string }
  | { type: 'row.selected'; rowId: string }
  | { type: 'connection.changed'; state: StreamConnectionState }
  | { type: 'stream.dropped'; count: number }
  | { type: 'stream.reconnect' }
  | { type: 'stream.gap'; fromSeq: number }
  | { type: 'filter.family'; family: DashboardEvent['family'] | 'all' }

const EMPTY_SNAPSHOT = createEmptyDashboardSnapshot()

function createReducerState(snapshot = EMPTY_SNAPSHOT): ReducerState {
  let reducer: ReducerState = {
    rows: new Map(),
    events: new Map(),
    lastProcessedHrcSeq: snapshot.cursors.lastHrcSeq ?? snapshot.window.fromHrcSeq ?? 0,
    droppedEvents: snapshot.summary.droppedEvents ?? 0,
    reconnectCount: snapshot.summary.reconnectCount ?? 0,
    window: {
      fromTs: snapshot.window.fromTs,
      toTs: snapshot.window.toTs,
      windowMs: Math.max(0, Date.parse(snapshot.window.toTs) - Date.parse(snapshot.window.fromTs)),
    },
  }

  for (const event of snapshot.events) {
    reducer = applyEvent(reducer, event)
  }

  return reducer
}

function summarize(
  snapshot: SessionDashboardSnapshot,
  reducer: ReducerState
): SessionDashboardSummary {
  return {
    ...snapshot.summary,
    droppedEvents: reducer.droppedEvents,
    reconnectCount: reducer.reconnectCount,
    streamLagMs: snapshot.summary.streamLagMs ?? 0,
  }
}

function rowsForState(state: DashboardReducerState, reducer = state.reducer): SessionTimelineRow[] {
  const reducedRows = selectSortedRows(reducer)
  if (reducedRows.length === 0) return state.snapshot.sessions

  const rowsById = new Map(state.snapshot.sessions.map((row) => [row.rowId, row]))
  for (const row of reducedRows) {
    const existing = rowsById.get(row.rowId)
    rowsById.set(
      row.rowId,
      existing
        ? {
            ...existing,
            ...row,
            runtime: { ...existing.runtime, ...row.runtime },
            acp: { ...existing.acp, ...row.acp },
            visualState: { ...existing.visualState, ...row.visualState },
            stats: { ...existing.stats, ...row.stats },
          }
        : row
    )
  }

  return [...rowsById.values()]
}

function eventsForState(state: DashboardReducerState, reducer = state.reducer): DashboardEvent[] {
  const events = selectVisibleEvents(reducer, {
    family: state.familyFilter === 'all' ? undefined : state.familyFilter,
  })
  return events.length > 0 ? events : state.snapshot.events
}

export function createInitialDashboardReducerState(): DashboardReducerState {
  const reducer = createReducerState()
  return {
    snapshot: EMPTY_SNAPSHOT,
    reducer,
    rows: [],
    events: [],
    summary: EMPTY_SNAPSHOT.summary,
    connectionState: 'disconnected',
    familyFilter: 'all',
  }
}

function reduceDashboardAction(
  state: DashboardReducerState,
  action: DashboardReducerAction
): Partial<DashboardReducerState> {
  switch (action.type) {
    case 'snapshot.loaded': {
      const reducer = createReducerState(action.snapshot)
      const next = { ...state, snapshot: action.snapshot, reducer }
      const defaultEvent = action.snapshot.events[0]
      const selectedEventStillExists = action.snapshot.events.some(
        (event) => event.id === state.selectedEventId
      )
      return {
        snapshot: action.snapshot,
        reducer,
        rows: rowsForState(next),
        events: eventsForState(next),
        summary: summarize(action.snapshot, reducer),
        selectedEventId: selectedEventStillExists ? state.selectedEventId : defaultEvent?.id,
        selectedRowId:
          selectedEventStillExists && state.selectedRowId
            ? state.selectedRowId
            : defaultEvent
              ? eventRowId(defaultEvent)
              : undefined,
        connectionState:
          state.connectionState === 'disconnected' ? 'connected' : state.connectionState,
      }
    }
    case 'event.received': {
      const reducer = compact(applyEvent(state.reducer, action.event))
      const snapshot = {
        ...state.snapshot,
        cursors: {
          ...state.snapshot.cursors,
          lastHrcSeq: reducer.lastProcessedHrcSeq,
          nextFromSeq: reducer.lastProcessedHrcSeq + 1,
        },
      }
      const next = { ...state, snapshot, reducer }
      return {
        snapshot,
        reducer,
        rows: rowsForState(next),
        events: eventsForState(next),
        summary: summarize(snapshot, reducer),
        lastHeartbeatAt: action.event.ts,
      }
    }
    case 'event.selected':
      return { selectedEventId: action.eventId }
    case 'row.selected':
      return { selectedRowId: action.rowId }
    case 'connection.changed':
      return { connectionState: action.state }
    case 'stream.dropped': {
      const reducer = {
        ...state.reducer,
        droppedEvents: state.reducer.droppedEvents + action.count,
      }
      return { reducer, summary: summarize(state.snapshot, reducer) }
    }
    case 'stream.reconnect': {
      const reducer = reconnect(state.reducer)
      return { reducer, summary: summarize(state.snapshot, reducer) }
    }
    case 'stream.gap':
      return { gapFromSeq: action.fromSeq, connectionState: 'degraded' }
    case 'filter.family': {
      const next = { ...state, familyFilter: action.family }
      return { familyFilter: action.family, events: eventsForState(next) }
    }
  }
}

function eventRowId(event: DashboardEvent): string {
  return `${event.hostSessionId}:${event.generation}`
}

const dashboardStore = create<DashboardReducerState>(() => createInitialDashboardReducerState())

export function useReducerStore<T>(selector: (state: DashboardReducerState) => T): T {
  return dashboardStore(selector)
}

export function dispatchDashboardAction(action: DashboardReducerAction): void {
  dashboardStore.setState((state) => reduceDashboardAction(state, action))
}

export function getDashboardState(): DashboardReducerState {
  return dashboardStore.getState()
}
