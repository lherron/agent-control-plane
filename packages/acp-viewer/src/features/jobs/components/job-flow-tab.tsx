import { JobFlowCanvas } from '@/components/job-flow-canvas'
import { EmptyState } from '@/components/primitives'
import type { JobDetailResponse } from '@/types/api'
import { GitBranch } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

interface JobFlowTabProps {
  data: JobDetailResponse
}

export function JobFlowTab({ data }: JobFlowTabProps) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const { flow, job } = data

  if (!flow) {
    return (
      <EmptyState
        icon={<GitBranch className="h-8 w-8" />}
        title="No flow"
        description={`Kind: ${data.summary.kind}.`}
      />
    )
  }

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <span className="kicker text-muted">
          {flow.sequence.length} sequence · {flow.onFailure.length} onFailure
        </span>
        <Link
          to={`/jobs/${encodeURIComponent(job.jobId)}/flow`}
          className="text-[12px] text-muted hover:text-accent transition-colors"
        >
          Open full view →
        </Link>
      </div>

      <JobFlowCanvas
        flow={flow}
        selectedStepId={selectedStepId}
        onSelect={setSelectedStepId}
        className="max-h-[440px]"
      />

      {flow.warnings.length > 0 && (
        <ul className="mt-4 space-y-1">
          {flow.warnings.map((w) => (
            <li key={w} className="mono text-[11px] text-warn">
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
