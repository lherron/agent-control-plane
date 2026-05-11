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

  const title = data.summary.title || data.job.jobId
  const cron = data.schedule.cron
  const nextFire = data.schedule.nextFireAt
    ? new Date(data.schedule.nextFireAt).toLocaleString()
    : '—'
  const lastFire = data.schedule.lastFireAt
    ? new Date(data.schedule.lastFireAt).toLocaleString()
    : '—'

  return (
    <div className="flex flex-col h-full">
      {/* Header — rich title + context strip per reference image */}
      <div className="px-6 pt-4 pb-3 border-b border-border bg-card">
        <div className="flex items-baseline gap-3 mb-1">
          <span className="text-base font-semibold text-foreground">JobFlow:</span>
          <span className="text-base font-mono text-foreground">{title}</span>
          <span className="text-[11px] font-mono text-quiet">{data.job.jobId}</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wide bg-accent/10 text-accent border border-accent/30">
            {data.summary.kind}
          </span>
          {data.job.disabled ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wide bg-red-50 text-red-700 border border-red-200">
              disabled
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200">
              enabled
            </span>
          )}
          <span className="ml-auto text-xs text-quiet">
            {data.flow.sequence.length} sequence · {data.flow.onFailure.length} onFailure ·{' '}
            {data.flow.edges.length} edges
          </span>
        </div>
        {data.job.description !== undefined && data.job.description.length > 0 && (
          <div className="text-xs text-muted mb-1">{data.job.description}</div>
        )}
        <div className="flex items-center gap-x-6 gap-y-1 flex-wrap text-xs text-muted">
          <span>
            <span className="text-quiet">project</span>{' '}
            <span className="text-foreground font-mono">{data.job.projectId}</span>
          </span>
          <span>
            <span className="text-quiet">agent</span>{' '}
            <span className="text-foreground font-mono">{data.job.agentId}</span>
          </span>
          <span>
            <span className="text-quiet">scope</span>{' '}
            <span className="text-foreground font-mono">{data.startup.scopeRef}</span>
          </span>
          <span>
            <span className="text-quiet">cron</span>{' '}
            <span className="text-foreground font-mono">{cron}</span>
          </span>
          <span>
            <span className="text-quiet">next fire</span>{' '}
            <span className="text-foreground">{nextFire}</span>
          </span>
          <span>
            <span className="text-quiet">last fire</span>{' '}
            <span className="text-foreground">{lastFire}</span>
          </span>
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
        <div className="w-96 border-l border-border bg-card overflow-hidden shrink-0 flex flex-col">
          {selectedStep ? (
            <StepInspector
              step={selectedStep}
              stepRuns={data.lineage.stepRuns}
              latestRuns={data.latestRuns}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-quiet text-xs p-6 text-center gap-2">
              <div className="text-[11px] uppercase tracking-wide text-muted">Step inspector</div>
              <div>Click a step in the flow canvas to inspect.</div>
            </div>
          )}
        </div>
      </div>

      {/* Provenance */}
      <ProvenanceStrip provenance={data.provenance} />
    </div>
  )
}
