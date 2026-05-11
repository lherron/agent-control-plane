import { JobFlowCanvas } from '@/components/job-flow-canvas'
import type { JobDetailResponse } from '@/types/api'
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
      <div className="p-4 text-xs text-quiet italic">
        This job has no flow defined (kind: {data.summary.kind}).
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">
          {flow.sequence.length} sequence step{flow.sequence.length !== 1 ? 's' : ''}
          {flow.onFailure.length > 0 && `, ${flow.onFailure.length} onFailure`}
          {flow.warnings.length > 0 && (
            <span className="text-amber-600 ml-2">
              ({flow.warnings.length} warning{flow.warnings.length !== 1 ? 's' : ''})
            </span>
          )}
        </div>
        <Link
          to={`/jobs/${encodeURIComponent(job.jobId)}/flow`}
          className="text-xs text-accent hover:underline"
        >
          Full flow view &rarr;
        </Link>
      </div>

      <JobFlowCanvas
        flow={flow}
        selectedStepId={selectedStepId}
        onSelect={setSelectedStepId}
        className="max-h-[300px]"
      />

      {flow.warnings.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="text-amber-600 font-medium">Warnings:</div>
          {flow.warnings.map((w) => (
            <div key={w} className="text-amber-600 font-mono pl-2">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
