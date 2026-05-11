import { FieldRow, Pill, SectionHeader } from '@/components/primitives'
import type { JobDetailResponse } from '@/types/api'
import { Link } from 'react-router-dom'

interface JobOverviewTabProps {
  data: JobDetailResponse
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}

export function JobOverviewTab({ data }: JobOverviewTabProps) {
  const { job, summary } = data

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-12 max-w-5xl">
      <section>
        <SectionHeader title="Identity" />
        <dl>
          <FieldRow label="Slug">
            <span className="mono">{job.slug}</span>
          </FieldRow>
          <FieldRow label="Job ID">
            <span className="mono text-muted">{job.jobId}</span>
          </FieldRow>
          <FieldRow label="Kind">
            <Pill
              tone={
                summary.kind === 'flow' ? 'accent' : summary.kind === 'exec' ? 'success' : 'muted'
              }
            >
              {summary.kind}
            </Pill>
          </FieldRow>
          {(summary.description || job.description) && (
            <FieldRow label="Description">{summary.description ?? job.description}</FieldRow>
          )}
        </dl>
      </section>

      <section>
        <SectionHeader title="Routing" />
        <dl>
          <FieldRow label="Project">
            <Link
              to={`/projects/${encodeURIComponent(job.projectId)}`}
              className="mono text-ink-link hover:text-accent transition-colors"
            >
              {job.projectId}
            </Link>
          </FieldRow>
          <FieldRow label="Agent">
            <Link
              to={`/agents/${encodeURIComponent(job.agentId)}`}
              className="mono text-ink-link hover:text-accent transition-colors"
            >
              {job.agentId}
            </Link>
          </FieldRow>
          <FieldRow label="Scope">
            <span className="mono">{job.scopeRef}</span>
          </FieldRow>
          <FieldRow label="Lane">
            <span className="mono">{job.laneRef}</span>
          </FieldRow>
          <FieldRow label="Actor">
            <span className="mono text-muted">
              {job.actor.kind}
              {job.actor.id ? `:${job.actor.id}` : ''}
            </span>
          </FieldRow>
        </dl>
      </section>

      <section className="xl:col-span-2">
        <SectionHeader title="Timestamps" />
        <dl>
          <FieldRow label="Created">{fmtDate(job.createdAt)}</FieldRow>
          <FieldRow label="Updated">{fmtDate(job.updatedAt)}</FieldRow>
        </dl>
      </section>
    </div>
  )
}
