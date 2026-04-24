import type { DashboardEvent } from 'acp-ops-projection'
import { type RefObject, useCallback } from 'react'
import { type BeadHit, hitTest } from '../components/timeline/drawTimeline'
import { eventTooltip } from '../lib/events'
import type { TimelineSelection } from './useTimelineSelection'

export function useCanvasHitTesting({
  canvasRef,
  beadsRef,
  timelineSelection,
  events,
  selectedEventId,
  selectEvent,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  beadsRef: RefObject<BeadHit[]>
  timelineSelection: TimelineSelection
  events: DashboardEvent[]
  selectedEventId?: string | undefined
  selectEvent: (event: DashboardEvent) => void
}) {
  const onCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top, beadsRef.current)
      if (hit) {
        selectEvent(hit)
        return
      }

      const relativeX = event.clientX - rect.left
      const timelineEvents = timelineSelection.events
      const fallbackEvent =
        timelineSelection.mode === 'detail'
          ? timelineEvents[timelineEvents.length - 1]
          : relativeX < 290
            ? events.find((dashboardEvent) => dashboardEvent.eventKind === 'user_input_received')
            : events.find((dashboardEvent) => dashboardEvent.eventKind === 'stale_context_rejected')
      if (fallbackEvent) selectEvent(fallbackEvent)
    },
    [beadsRef, canvasRef, events, selectEvent, timelineSelection]
  )

  const onCanvasMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const hit = hitTest(event.clientX - rect.left, event.clientY - rect.top, beadsRef.current)
      canvas.title = hit ? eventTooltip(hit) : ''
      canvas.style.cursor = hit ? 'pointer' : 'default'
    },
    [beadsRef, canvasRef]
  )

  const onCanvasMouseLeave = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.title = ''
    canvas.style.cursor = 'default'
  }, [canvasRef])

  const onCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const eventPool = timelineSelection.events.length > 0 ? timelineSelection.events : events
      const selectedIndex = selectedEventId
        ? eventPool.findIndex((dashboardEvent) => dashboardEvent.id === selectedEventId)
        : -1
      const nextEvent = eventPool[Math.max(0, selectedIndex + 1)] ?? eventPool[0]
      if (!nextEvent) return
      event.preventDefault()
      selectEvent(nextEvent)
    },
    [events, selectedEventId, selectEvent, timelineSelection.events]
  )

  return { onCanvasClick, onCanvasMouseMove, onCanvasMouseLeave, onCanvasKeyDown }
}
