import type { RefObject } from 'react'
import type { TimelineMeta } from './drawTimeline'

export type TimelineCanvasHandlers = {
  onCanvasClick: (event: React.MouseEvent<HTMLCanvasElement>) => void
  onCanvasMouseMove: (event: React.MouseEvent<HTMLCanvasElement>) => void
  onCanvasMouseLeave: () => void
  onCanvasKeyDown: (event: React.KeyboardEvent<HTMLCanvasElement>) => void
}

export function TimelineCanvas({
  canvasRef,
  paused,
  reducedMotion,
  meta,
  handlers,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  paused: boolean
  reducedMotion: boolean
  meta: TimelineMeta
  handlers: TimelineCanvasHandlers
}) {
  return (
    <canvas
      ref={canvasRef}
      className="temporal-canvas"
      data-testid="temporal-canvas"
      data-live-mode={paused ? 'paused' : 'live'}
      data-now-x={String(meta.nowX)}
      data-branch-count={String(meta.branchCount)}
      data-rejoin-count={String(meta.rejoinCount)}
      data-warning-count={String(meta.warningCount)}
      data-reduced-motion={String(reducedMotion)}
      data-pulse-animation={reducedMotion ? 'disabled' : 'enabled'}
      data-trail-animation={reducedMotion ? 'disabled' : 'enabled'}
      aria-label="temporal canvas"
      tabIndex={0}
      onClick={handlers.onCanvasClick}
      onMouseMove={handlers.onCanvasMouseMove}
      onMouseLeave={handlers.onCanvasMouseLeave}
      onKeyDown={handlers.onCanvasKeyDown}
    />
  )
}
