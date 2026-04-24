import type { DashboardEvent } from 'acp-ops-projection'
import { useEffect, useMemo, useRef } from 'react'
import {
  DETAIL_EVENT_LIMIT,
  eventTooltip,
  payloadPreview,
  sortedEvents,
  streamCardKind,
  streamCardTitle,
} from '../../lib/events'
import { clockLabel } from '../../lib/time'

export function TimelineEventStream({
  events,
  selectEvent,
}: {
  events: DashboardEvent[]
  selectEvent: (event: DashboardEvent) => void
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const recentEvents = useMemo(() => sortedEvents(events).slice(-DETAIL_EVENT_LIMIT), [events])

  // Scroll the list to the bottom when new events land. The effect doesn't
  // read events.length directly, but it needs to fire when the stream grows —
  // biome's exhaustive-deps rule wants only consumed dependencies, so suppress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll-on-grow
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [events.length])

  return (
    <section className="timeline-event-stream" aria-label="selected session event stream">
      <header>
        <strong>Event Stream</strong>
        <span>{recentEvents.length} loaded</span>
      </header>
      {recentEvents.length === 0 ? (
        <p className="event-strip-empty">Select a session with events.</p>
      ) : (
        <ol ref={listRef} className="timeline-stream-cards">
          {recentEvents.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`stream-card stream-card-${streamCardKind(item)} tone-${item.family}`}
                title={eventTooltip(item)}
                onClick={() => selectEvent(item)}
              >
                <time>{clockLabel(item.ts)}</time>
                <span className="stream-seq">{item.hrcSeq}</span>
                <strong>{streamCardTitle(item)}</strong>
                <em>{item.eventKind}</em>
                <p>{payloadPreview(item)}</p>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
