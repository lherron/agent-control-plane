import { JobFlowCanvas } from '@/components/job-flow-canvas'
import { StepInspector } from '@/components/job-flow-canvas/step-inspector'
import { PageHeader } from '@/components/page-header'
import {
  BackLink,
  EmptyState,
  ErrorBanner,
  PageLoading,
  Pill,
  StatusDot,
} from '@/components/primitives'
import { ProvenanceStrip } from '@/components/provenance-strip'
import { getJobDetail } from '@/lib/api'
import type { NormalizedFlowStep } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, MousePointerClick } from 'lucide-react'
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

  if (isLoading) return <PageLoading label="Loading" />
  if (error) return <ErrorBanner message={String(error)} />
  if (!data) return <ErrorBanner message={`Job ${jobId} not found.`} />
  if (!data.flow) {
    return <EmptyState icon={<GitBranch className="h-8 w-8" />} title="No flow defined" />
  }

  const title = data.job.slug || data.job.jobId

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-10 pt-8 rise rise-1">
        <BackLink to={`/jobs/${encodeURIComponent(data.job.jobId)}`} label={title} />
      </div>

      <PageHeader
        title="Flow"
        right={
          <div className="flex items-center gap-3">
            <Pill tone={data.job.disabled ? 'destructive' : 'success'}>
              <StatusDot
                tone={data.job.disabled ? 'destructive' : 'success'}
                pulse={!data.job.disabled}
              />
              {data.job.disabled ? 'disabled' : 'enabled'}
            </Pill>
          </div>
        }
        meta={[
          { label: 'Sequence', value: data.flow.sequence.length },
          { label: 'onFailure', value: data.flow.onFailure.length },
          { label: 'Edges', value: data.flow.edges.length },
        ]}
      />

      <div className="flex-1 grid grid-cols-[minmax(0,1fr)_400px] min-h-0 rise rise-2 border-t border-border/60">
        <div className="overflow-auto p-8 bg-background">
          <JobFlowCanvas
            flow={data.flow}
            selectedStepId={selectedStepId}
            onSelect={setSelectedStepId}
          />
          {data.flow.warnings.length > 0 && (
            <ul className="mt-4 space-y-1">
              {data.flow.warnings.map((w) => (
                <li key={w} className="mono text-[11px] text-warn">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="border-l border-border/60 bg-paper overflow-hidden flex flex-col min-h-0">
          {selectedStep ? (
            <StepInspector
              step={selectedStep}
              stepRuns={data.lineage.stepRuns}
              latestRuns={data.latestRuns}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <MousePointerClick className="h-7 w-7 text-muted/50" />
              <p className="text-[12px] text-muted max-w-[16rem]">Click any step to inspect.</p>
            </div>
          )}
        </aside>
      </div>

      <ProvenanceStrip provenance={data.provenance} />
    </div>
  )
}
