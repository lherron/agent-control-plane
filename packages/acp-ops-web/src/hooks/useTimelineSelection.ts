import type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'
import { useCallback, useMemo } from 'react'
import type { TimelineMode } from '../components/timeline/drawTimeline'
import { DETAIL_EVENT_LIMIT, sortedEvents } from '../lib/events'
import {
  eventKey,
  eventMatchesRow,
  rowKey,
  rowMatchesRef,
  sameSessionFamily,
} from '../lib/sessionRefs'
import { dispatchDashboardAction } from '../store/useReducerStore'

const EVENT_LIMIT = 5_000
const CANVAS_ROW_LIMIT = 3
const DETAIL_GENERATION_LIMIT = 3

export type TimelineSelection = {
  mode: TimelineMode
  rows: SessionTimelineRow[]
  events: DashboardEvent[]
  selectedRow?: SessionTimelineRow | undefined
}

export function sortRows(rows: SessionTimelineRow[], selectedRowId?: string): SessionTimelineRow[] {
  const priority = (row: SessionTimelineRow) => {
    if (row.rowId === selectedRowId || rowKey(row) === selectedRowId) return 0
    if (row.runtime?.status === 'busy' && row.acp?.inputAttemptId) return 1
    if (
      row.runtime?.status === 'stale' ||
      row.runtime?.status === 'dead' ||
      row.visualState.continuity === 'blocked' ||
      row.visualState.continuity === 'broken'
    ) {
      return row.runtime?.status === 'stale' || row.runtime?.status === 'dead' ? 7 : 2
    }
    if (row.runtime?.status === 'launching') return 3
    if (row.runtime?.status === 'busy') return 4
    if (row.acp?.deliveryPending) return 5
    return 6
  }

  return [...rows].sort((left, right) => {
    const leftPriority = priority(left)
    const rightPriority = priority(right)
    if (leftPriority !== rightPriority) return leftPriority - rightPriority
    return (right.stats.lastEventAt ?? '').localeCompare(left.stats.lastEventAt ?? '')
  })
}

export function selectTimeline(
  rows: SessionTimelineRow[],
  events: DashboardEvent[],
  selectedRowId?: string
): TimelineSelection {
  const selectedRow = selectedRowId
    ? rows.find((row) => rowMatchesRef(row, selectedRowId))
    : undefined

  if (!selectedRow) {
    const overviewRows = rows.slice(0, CANVAS_ROW_LIMIT)
    const overviewRowKeys = new Set(overviewRows.map(rowKey))
    const overviewEvents = sortedEvents(events)
      .filter((event) => overviewRowKeys.has(eventKey(event)))
      .slice(-EVENT_LIMIT)
    return { mode: 'overview', rows: overviewRows, events: overviewEvents }
  }

  const detailRows = rows
    .filter(
      (row) =>
        row.sessionRef.scopeRef === selectedRow.sessionRef.scopeRef &&
        row.sessionRef.laneRef === selectedRow.sessionRef.laneRef
    )
    .sort((left, right) => {
      if (rowKey(left) === rowKey(selectedRow)) return -1
      if (rowKey(right) === rowKey(selectedRow)) return 1
      if (left.generation !== right.generation) return right.generation - left.generation
      return (right.stats.lastEventAt ?? '').localeCompare(left.stats.lastEventAt ?? '')
    })
    .slice(0, DETAIL_GENERATION_LIMIT)
  const detailRowKeys = new Set(detailRows.map(rowKey))
  const detailEvents = sortedEvents(events)
    .filter((event) => sameSessionFamily(selectedRow.sessionRef, event.sessionRef))
    .filter((event) => detailRowKeys.has(eventKey(event)))
    .slice(-DETAIL_EVENT_LIMIT)

  return { mode: 'detail', rows: detailRows, events: detailEvents, selectedRow }
}

export function useTimelineSelection({
  rows,
  events,
  selectedRowId,
  selectedEventId,
}: {
  rows: SessionTimelineRow[]
  events: DashboardEvent[]
  selectedRowId?: string | undefined
  selectedEventId?: string | undefined
}) {
  const visibleRows = useMemo(() => sortRows(rows, selectedRowId), [rows, selectedRowId])
  const selectedTimelineRow = useMemo(
    () =>
      selectedRowId ? visibleRows.find((row) => rowMatchesRef(row, selectedRowId)) : undefined,
    [visibleRows, selectedRowId]
  )
  const timelineSelection = useMemo(
    () => selectTimeline(visibleRows, events, selectedRowId),
    [visibleRows, events, selectedRowId]
  )
  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  )

  const selectEvent = useCallback((event: DashboardEvent) => {
    dispatchDashboardAction({ type: 'event.selected', eventId: event.id })
    dispatchDashboardAction({ type: 'row.selected', rowId: eventKey(event) })
  }, [])

  const selectRow = useCallback(
    (row: SessionTimelineRow) => {
      dispatchDashboardAction({ type: 'row.selected', rowId: row.rowId })
      const rowEvents = sortedEvents(events).filter((event) => eventMatchesRow(event, row))
      const latestEvent = rowEvents[rowEvents.length - 1]
      if (latestEvent) {
        dispatchDashboardAction({ type: 'event.selected', eventId: latestEvent.id })
      }
    },
    [events]
  )

  return {
    visibleRows,
    selectedTimelineRow,
    timelineSelection,
    selectedEvent,
    selectEvent,
    selectRow,
  }
}
