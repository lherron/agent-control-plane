import { Badge } from '@/components/ui/badge'
import type { JobDetailResponse } from '@/types/api'
import { Link } from 'react-router-dom'

interface JobOverviewTabProps {
  data: JobDetailResponse
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted w-28 shrink-0">{label}</span>
      <span className="text-foreground">{children}</span>
    </div>
  )
}

export function JobOverviewTab({ data }: JobOverviewTabProps) {
  const { job, summary } = data

  return (
    <div className="space-y-3 p-4">
      <Field label="Job ID">
        <span className="font-mono">{job.jobId}</span>
      </Field>
      <Field label="Kind">
        <Badge variant="outline" className="text-[10px]">
          {summary.kind}
        </Badge>
      </Field>
      <Field label="State">
        <Badge variant={job.disabled ? 'destructive' : 'secondary'} className="text-[10px]">
          {job.disabled ? 'disabled' : 'enabled'}
        </Badge>
        {summary.disabledReason && (
          <span className="text-quiet ml-2">{summary.disabledReason}</span>
        )}
      </Field>
      <Field label="Title">{summary.title}</Field>
      {summary.description && <Field label="Description">{summary.description}</Field>}
      <Field label="Project">
        <Link
          to={`/projects/${encodeURIComponent(job.projectId)}`}
          className="text-accent hover:underline font-mono"
        >
          {job.projectId}
        </Link>
      </Field>
      <Field label="Agent">
        <Link
          to={`/agents/${encodeURIComponent(job.agentId)}`}
          className="text-accent hover:underline font-mono"
        >
          {job.agentId}
        </Link>
      </Field>
      <Field label="Scope Ref">
        <span className="font-mono">{job.scopeRef}</span>
      </Field>
      <Field label="Lane Ref">
        <span className="font-mono">{job.laneRef}</span>
      </Field>
      <Field label="Flow Steps">{summary.flowStepCount}</Field>
      {summary.onFailureStepCount > 0 && (
        <Field label="onFailure Steps">{summary.onFailureStepCount}</Field>
      )}
      <Field label="Actor">
        <span className="font-mono">
          {job.actor.kind}
          {job.actor.id ? `:${job.actor.id}` : ''}
        </span>
      </Field>
      <Field label="Created">{new Date(job.createdAt).toLocaleString()}</Field>
      <Field label="Updated">{new Date(job.updatedAt).toLocaleString()}</Field>
    </div>
  )
}
