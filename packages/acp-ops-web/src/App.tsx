import { useEffect, useMemo, useState } from 'react'
import { DashboardShell } from './components/DashboardShell'
import { type ConnectionState, ReplayControls } from './components/controls/ReplayControls'
import { EventInspector } from './components/inspector/EventInspector'
import { SessionQueue } from './components/session/SessionQueue'
import { StatusStrip } from './components/status/StatusStrip'
import { TimelinePanel } from './components/timeline/TimelinePanel'
import { useCanvasHitTesting } from './hooks/useCanvasHitTesting'
import { useCanvasRenderer, useReducedMotionPreference } from './hooks/useCanvasRenderer'
import { useDashboardStream } from './hooks/useDashboardStream'
import { useDetailEventBackfill } from './hooks/useDetailEventBackfill'
import { useTimelineSelection } from './hooks/useTimelineSelection'
import { eventMatchesRow } from './lib/sessionRefs'
import { dispatchDashboardAction, useReducerStore } from './store/useReducerStore'

export function App() {
  const snapshot = useReducerStore((state) => state.snapshot)
  const rows = useReducerStore((state) => state.rows)
  const events = useReducerStore((state) => state.events)
  const summary = useReducerStore((state) => state.summary)
  const selectedEventId = useReducerStore((state) => state.selectedEventId)
  const selectedRowId = useReducerStore((state) => state.selectedRowId)
  const connectionState = useReducerStore((state) => state.connectionState) as ConnectionState
  const lastHeartbeatAt = useReducerStore((state) => state.lastHeartbeatAt)
  const gapFromSeq = useReducerStore((state) => state.gapFromSeq)
  const familyFilter = useReducerStore((state) => state.familyFilter)

  const [highContrast, setHighContrast] = useState(false)
  const reducedMotion = useReducedMotionPreference()
  const { paused, pause, goLive } = useDashboardStream(familyFilter)

  const replayCursor = snapshot.cursors.lastHrcSeq ?? snapshot.window.toHrcSeq ?? 0

  const initialSelection = useTimelineSelection({
    rows,
    events,
    selectedRowId,
    selectedEventId,
  })
  const timelineEvents = useDetailEventBackfill({
    selectedTimelineRow: initialSelection.selectedTimelineRow,
    events,
    replayCursor,
  })
  const {
    visibleRows,
    selectedTimelineRow,
    timelineSelection,
    selectedEvent,
    selectEvent,
    selectRow,
  } = useTimelineSelection({
    rows,
    events: timelineEvents,
    selectedRowId,
    selectedEventId,
  })

  useEffect(() => {
    if (!selectedTimelineRow) return
    const rowEvents = timelineEvents.filter((event) => eventMatchesRow(event, selectedTimelineRow))
    const latestEvent = rowEvents[rowEvents.length - 1]
    if (!latestEvent) return
    if (selectedEventId !== undefined && rowEvents.some((event) => event.id === selectedEventId)) {
      return
    }
    dispatchDashboardAction({ type: 'event.selected', eventId: latestEvent.id })
  }, [selectedTimelineRow, timelineEvents, selectedEventId])

  const { canvasRef, beadsRef, meta } = useCanvasRenderer({
    snapshot,
    timelineSelection,
    selectedEventId,
    paused,
    reducedMotion,
    gapFromSeq,
  })

  const canvasHandlers = useCanvasHitTesting({
    canvasRef,
    beadsRef,
    timelineSelection,
    events: timelineEvents,
    selectedEventId,
    selectEvent,
  })

  const effectiveConnectionState = paused ? 'paused' : connectionState
  const controls = useMemo(
    () => (
      <ReplayControls
        paused={paused}
        highContrast={highContrast}
        familyFilter={familyFilter}
        replayCursor={replayCursor}
        summary={summary}
        lastHeartbeatAt={lastHeartbeatAt}
        effectiveConnectionState={effectiveConnectionState}
        onGoLive={goLive}
        onPause={pause}
        onHighContrastChange={setHighContrast}
      />
    ),
    [
      paused,
      highContrast,
      familyFilter,
      replayCursor,
      summary,
      lastHeartbeatAt,
      effectiveConnectionState,
      goLive,
      pause,
    ]
  )

  return (
    <DashboardShell
      highContrast={highContrast}
      serverTime={snapshot.serverTime}
      status={<StatusStrip summary={summary} />}
      queue={
        <SessionQueue rows={visibleRows} selectedRowId={selectedRowId} onSelectRow={selectRow} />
      }
      timeline={
        <TimelinePanel
          canvasRef={canvasRef}
          timelineSelection={timelineSelection}
          paused={paused}
          reducedMotion={reducedMotion}
          meta={meta}
          handlers={canvasHandlers}
          selectEvent={selectEvent}
        />
      }
      inspector={<EventInspector event={selectedEvent} />}
      controls={controls}
    />
  )
}
