import { JobFlowCanvas } from '@/components/job-flow-canvas'
import { StepInspector } from '@/components/job-flow-canvas/step-inspector'
import { ProvenanceStrip } from '@/components/provenance-strip'
import { getJobDetail } from '@/lib/api'
import type { NormalizedFlowStep } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

export function JobFlow() {
  const { jobId } = useParams<{ jobId: string }>()
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['job-detail', jobId],
    // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
    queryFn: () => getJobDetail(jobId!),
    enabled: !!jobId,
  })

  const selectedStep: NormalizedFlowStep | undefined = useMemo(() => {
    if (!data?.flow || !selectedStepId) return undefined
    return data.flow.nodes.find((n) => n.id === selectedStepId)
  }, [data?.flow, selectedStepId])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading flow...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        Error: {String(error)}
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-quiet text-sm">
        Job not found.
      </div>
    )
  }

  if (!data.flow) {
    return (
      <div className="flex items-center justify-center h-full text-quiet text-sm">
        This job has no flow definition.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border bg-card flex items-center gap-3">
        <div>
          <span className="font-semibold text-sm text-foreground">{data.job.jobId}</span>
          <span className="text-xs text-muted ml-2">JobFlow</span>
        </div>
        <div className="text-xs text-quiet ml-auto">
          {data.flow.sequence.length} sequence &middot; {data.flow.onFailure.length} onFailure
          &middot; {data.flow.edges.length} edges
        </div>
      </div>

      {/* Main area: canvas + inspector */}
      <div className="flex-1 flex min-h-0">
        {/* Canvas */}
        <div className="flex-1 overflow-auto p-4">
          <JobFlowCanvas
            flow={data.flow}
            selectedStepId={selectedStepId}
            onSelect={setSelectedStepId}
          />
        </div>

        {/* Inspector panel */}
        <div className="w-80 border-l border-border bg-card overflow-auto shrink-0">
          {selectedStep ? (
            <StepInspector
              step={selectedStep}
              stepRuns={data.lineage.stepRuns}
              latestRuns={data.latestRuns}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-quiet">
              Click a step to inspect
            </div>
          )}
        </div>
      </div>

      {/* Provenance */}
      <ProvenanceStrip provenance={data.provenance} />
    </div>
  )
}
