import { EmptyState, Pill, StatusDot } from '@/components/primitives'
import { runStatusTone as statusTone } from '@/lib/tone'
import type { JobDetailResponse } from '@/types/api'
import { Activity } from 'lucide-react'

interface JobRunsTabProps {
  data: JobDetailResponse
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

const GRID = '12px minmax(220px,1.4fr) 100px 110px minmax(160px,1fr) minmax(160px,1fr)'

export function JobRunsTab({ data }: JobRunsTabProps) {
  const { latestRuns } = data

  if (latestRuns.length === 0) {
    return <EmptyState icon={<Activity className="h-8 w-8" />} title="No runs yet" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {[null, 'Run', 'Status', 'Trigger', 'Started', 'Completed'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label ?? ''}
          </span>
        ))}
      </div>

      <ul>
        {latestRuns.map((run) => (
          <li
            key={run.jobRunId}
            style={{ gridTemplateColumns: GRID }}
            className="grid items-center gap-x-6 py-3 border-b border-border/40"
          >
            <StatusDot tone={statusTone(run.status)} />
            <span className="mono text-[12px] text-ink truncate">{run.jobRunId}</span>
            <Pill tone={statusTone(run.status)}>{run.status}</Pill>
            <span className="text-[12px] text-ink">{run.triggeredBy}</span>
            <span className="mono text-[12px] tabular text-ink">{fmtDate(run.triggeredAt)}</span>
            <span className="mono text-[12px] tabular text-muted">{fmtDate(run.completedAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
