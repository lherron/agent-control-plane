import type { DashboardEvent } from 'acp-ops-projection'
import type { RefObject } from 'react'
import type { TimelineSelection } from '../../hooks/useTimelineSelection'
import { TimelineCanvas, type TimelineCanvasHandlers } from './TimelineCanvas'
import { TimelineEventStream } from './TimelineEventStream'
import { FAMILY_LANES, type TimelineMeta } from './drawTimeline'

export function TimelinePanel({
  canvasRef,
  timelineSelection,
  paused,
  reducedMotion,
  meta,
  handlers,
  selectEvent,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>
  timelineSelection: TimelineSelection
  paused: boolean
  reducedMotion: boolean
  meta: TimelineMeta
  handlers: TimelineCanvasHandlers
  selectEvent: (event: DashboardEvent) => void
}) {
  return (
    <section className="canvas-panel" aria-label="temporal session timeline">
      <div className="panel-heading timeline-heading">
        <h2>
          Timeline
          {timelineSelection.mode === 'detail' && <span>/ Selected</span>}
        </h2>
        <div>
          {timelineSelection.mode === 'detail' && (
            <span className="timeline-scope">
              {timelineSelection.rows.length} lane{timelineSelection.rows.length === 1 ? '' : 's'} ·{' '}
              {timelineSelection.events.length} events
            </span>
          )}
          <label>
            Scale
            <select defaultValue="1m" aria-label="timeline scale">
              <option value="1m">1m</option>
              <option value="5m">5m</option>
            </select>
          </label>
          <button type="button">Fit</button>
          <button type="button" aria-label="zoom timeline">
            ↔
          </button>
          <button type="button" aria-label="expand timeline">
            ↗
          </button>
        </div>
      </div>
      <TimelineCanvas
        canvasRef={canvasRef}
        paused={paused}
        reducedMotion={reducedMotion}
        meta={meta}
        handlers={handlers}
      />
      {timelineSelection.mode === 'detail' ? (
        <TimelineEventStream events={timelineSelection.events} selectEvent={selectEvent} />
      ) : (
        <div className="event-list-fallback" aria-label="visible events">
          {FAMILY_LANES.map((family) => (
            <button key={family} type="button">
              <span className={`status-dot ${family}`} aria-hidden="true" />
              <span>{family.replace('_', ' ')}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
