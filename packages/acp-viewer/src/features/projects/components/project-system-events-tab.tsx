import { EmptyState, Pill } from '@/components/primitives'
import { Activity } from 'lucide-react'
import { formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectSystemEventsTab({ detail }: Props) {
  if (detail.recentSystemEvents.length === 0) {
    return <EmptyState icon={<Activity className="h-8 w-8" />} title="No events" />
  }

  return (
    <ol className="space-y-6 max-w-5xl">
      {detail.recentSystemEvents.map((e) => (
        <li key={e.eventId}>
          <header className="flex items-baseline justify-between gap-4 pb-2 border-b border-border/40">
            <div className="flex items-baseline gap-3">
              <Pill tone="accent">{e.kind}</Pill>
              <span className="mono text-[11px] text-muted">
                {formatDateTime(e.occurredAt ?? e.recordedAt)}
              </span>
            </div>
            <span className="mono text-[10px] text-quiet">{e.eventId}</span>
          </header>
          <pre className="mt-2 mono text-[11px] leading-relaxed text-ink overflow-auto max-h-72 whitespace-pre-wrap">
{JSON.stringify(e.payload, null, 2)}
          </pre>
        </li>
      ))}
    </ol>
  )
}
