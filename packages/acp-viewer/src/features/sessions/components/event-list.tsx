import { ScrollArea } from '@/components/ui/scroll-area'
import type { DashboardEvent } from '@/features/sessions/types'
import { cn } from '@/lib/cn'
import { ArrowUpRight, ListTree } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  agentIdFromSessionRef,
  clockLabel,
  compactRef,
  FAMILY_ACCENT,
  FAMILY_BORDER,
  FAMILY_TEXT,
  payloadPreview,
  severityTone,
} from './event-family'

const WINDOW_SIZE = 200

export function EventList({
  events,
  selectedEventId,
  onSelectEvent,
}: {
  events: DashboardEvent[]
  selectedEventId?: string | undefined
  onSelectEvent: (eventId: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const visibleEvents = useMemo(() => events.slice(-WINDOW_SIZE), [events])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [visibleEvents.length])

  return (
    <section className="flex min-h-[420px] flex-1 flex-col border-b border-border bg-background/35">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-paper/35 px-4 py-3">
        <div>
          <h2 className="display text-[22px] leading-none text-ink">Event stream</h2>
          <p className="mt-1 text-[12px] text-muted">
            Showing last {visibleEvents.length} of {events.length}
          </p>
        </div>
        <span className="kicker text-muted">windowed</span>
      </header>

      <ScrollArea ref={listRef} className="flex-1">
        {visibleEvents.length === 0 ? (
          <div className="grid min-h-[300px] place-items-center px-6">
            <div className="max-w-sm text-center">
              <ListTree className="mx-auto h-9 w-9 text-muted" />
              <h3 className="display mt-4 text-[28px] leading-none text-ink">No events yet</h3>
              <p className="mt-3 text-[13px] leading-6 text-muted">
                Live hrc events will append here after the dashboard socket produces a snapshot or
                stream frame.
              </p>
            </div>
          </div>
        ) : (
          <ol className="divide-y divide-border/60">
            {visibleEvents.map((event) => {
              const agentId = agentIdFromSessionRef(event.sessionRef)
              const selected = event.id === selectedEventId
              return (
                <li key={event.id}>
                  <div
                    className={cn(
                      'group grid grid-cols-[92px_minmax(0,1fr)_auto] items-start gap-4 border-l-2 px-4 py-3 transition-colors',
                      FAMILY_BORDER[event.family],
                      selected ? 'bg-selected/70' : 'hover:bg-paper/45'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectEvent(event.id)}
                      className="contents text-left"
                    >
                      <span className="mono text-[11px] tabular text-muted">
                        {clockLabel(event.ts)}
                        <span className="mt-1 block text-quiet">#{event.hrcSeq}</span>
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn('h-2 w-2 rounded-full', FAMILY_ACCENT[event.family])}
                            aria-hidden="true"
                          />
                          <strong className="truncate text-[13px] font-semibold text-ink">
                            {event.label || event.eventKind}
                          </strong>
                          <span className={cn('mono text-[10px] uppercase', FAMILY_TEXT[event.family])}>
                            {event.family}
                          </span>
                          <span className={cn('mono text-[10px] uppercase', severityTone(event.severity))}>
                            {event.severity}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-[12px] text-muted">
                          {payloadPreview(event)}
                        </span>
                        <span className="mt-1 block truncate mono text-[10px] text-quiet">
                          {compactRef(event.sessionRef.scopeRef, 58)} / {event.sessionRef.laneRef}
                        </span>
                      </span>
                    </button>

                    {agentId ? (
                      <Link
                        to={`/agents/${encodeURIComponent(agentId)}`}
                        aria-label={`Open ${agentId} agent detail`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-quiet opacity-0 transition hover:bg-secondary hover:text-accent group-hover:opacity-100 focus:opacity-100"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <span className="h-8 w-8" />
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </ScrollArea>
    </section>
  )
}

