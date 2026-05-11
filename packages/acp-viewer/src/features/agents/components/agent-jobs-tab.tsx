import { EmptyState, Pill, StatusDot } from '@/components/primitives'
import { Workflow } from 'lucide-react'
import { Link } from 'react-router-dom'
import { getJobCron, getJobId, getJobKind, getJobNextFireAt, getJobProjectId } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

function tone(kind: string): 'accent' | 'success' | 'muted' {
  if (kind === 'flow') return 'accent'
  if (kind === 'exec') return 'success'
  return 'muted'
}

const GRID = '14px minmax(260px,1.6fr) 140px minmax(110px,0.6fr) 70px minmax(160px,0.9fr)'

export function AgentJobsTab({ detail }: Props) {
  if (detail.jobs.length === 0) {
    return <EmptyState icon={<Workflow className="h-8 w-8" />} title="No assigned jobs" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {[null, 'Job', 'Project', 'Cron', 'Kind', 'Next fire'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label ?? ''}
          </span>
        ))}
      </div>

      <ul>
        {detail.jobs.map((job) => {
          const jobId = getJobId(job)
          const kind = getJobKind(job)
          return (
            <li
              key={jobId}
              style={{ gridTemplateColumns: GRID }}
              className="grid items-center gap-x-6 py-3 border-b border-border/40"
            >
              <StatusDot tone="accent" />
              <Link to={`/jobs/${encodeURIComponent(jobId)}`} className="min-w-0 group">
                <div className="text-[13px] text-ink truncate group-hover:text-accent">
                  {job.summary?.title ?? jobId}
                </div>
                <div className="mono text-[10px] text-muted truncate">{jobId}</div>
              </Link>
              <span className="mono text-[11px] text-ink truncate">{getJobProjectId(job)}</span>
              <span className="mono text-[11px] tabular text-ink truncate">{getJobCron(job)}</span>
              <Pill tone={tone(kind)}>{kind}</Pill>
              <span className="mono text-[11px] tabular text-muted truncate">
                {getJobNextFireAt(job)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
