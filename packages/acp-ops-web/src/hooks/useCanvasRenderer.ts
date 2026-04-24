import type { SessionDashboardSnapshot } from 'acp-ops-projection'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type BeadHit,
  type TimelineMeta,
  computeTimelineLayout,
  drawTimeline,
  timelineWindowForEvents,
} from '../components/timeline/drawTimeline'
import type { TimelineSelection } from './useTimelineSelection'

export function useReducedMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(media.matches)
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return reducedMotion
}

export function useCanvasRenderer({
  snapshot,
  timelineSelection,
  selectedEventId,
  paused,
  reducedMotion,
  gapFromSeq,
}: {
  snapshot: SessionDashboardSnapshot
  timelineSelection: TimelineSelection
  selectedEventId?: string | undefined
  paused: boolean
  reducedMotion: boolean
  gapFromSeq?: number | undefined
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const beadsRef = useRef<BeadHit[]>([])
  const rafRef = useRef<number | undefined>(undefined)
  const [meta, setMeta] = useState<TimelineMeta>({
    branchCount: 0,
    rejoinCount: 0,
    warningCount: 0,
    nowX: 0,
  })

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = Math.max(1, Math.floor(canvas.clientWidth))
    const height = Math.max(1, Math.floor(canvas.clientHeight))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const timelineWindow =
      timelineSelection.mode === 'detail'
        ? timelineWindowForEvents(
            timelineSelection.events,
            snapshot.window.fromTs,
            snapshot.window.toTs
          )
        : snapshot.window
    const layout = computeTimelineLayout(width, height, timelineWindow.fromTs, timelineWindow.toTs)
    const result = drawTimeline({
      ctx,
      layout,
      rows: timelineSelection.rows,
      events: timelineSelection.events,
      mode: timelineSelection.mode,
      selectedEventId,
      paused,
      reducedMotion,
      gapFromSeq,
      frozenNowX: meta.nowX || undefined,
    })
    beadsRef.current = result.beads
    setMeta((current) =>
      current.branchCount === result.meta.branchCount &&
      current.rejoinCount === result.meta.rejoinCount &&
      current.warningCount === result.meta.warningCount &&
      current.nowX === result.meta.nowX
        ? current
        : result.meta
    )
  }, [
    snapshot.window,
    timelineSelection,
    selectedEventId,
    paused,
    reducedMotion,
    gapFromSeq,
    meta.nowX,
  ])

  useEffect(() => {
    const tick = () => {
      renderCanvas()
      rafRef.current = window.requestAnimationFrame(tick)
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current)
    }
  }, [renderCanvas])

  return { canvasRef, beadsRef, meta }
}
