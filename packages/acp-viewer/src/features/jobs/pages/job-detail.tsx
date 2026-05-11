import { PageHeader } from '@/components/page-header'
import {
  BackLink,
  ErrorBanner,
  PageLoading,
  Pill,
  StatusDot,
  TabBar,
} from '@/components/primitives'
import { ProvenanceStrip } from '@/components/provenance-strip'
import { getJobDetail } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { JobFlowTab } from '../components/job-flow-tab'
import { JobOverviewTab } from '../components/job-overview-tab'
import { JobRawTab } from '../components/job-raw-tab'
import { JobRunsTab } from '../components/job-runs-tab'
import { JobScheduleTab } from '../components/job-schedule-tab'
import { JobStartupTab } from '../components/job-startup-tab'

type DetailTab = 'overview' | 'startup' | 'schedule' | 'flow' | 'runs' | 'raw'

const TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'startup', label: 'Startup' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'flow', label: 'Flow' },
  { id: 'runs', label: 'Runs' },
  { id: 'raw', label: 'Raw' },
]

export function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')

  const { data, isLoading, error } = useQuery({
    queryKey: ['job-detail', jobId],
    // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
    queryFn: () => getJobDetail(jobId!),
    enabled: !!jobId,
  })

  if (isLoading) return <PageLoading label="Loading" />
  if (error) return <ErrorBanner message={String(error)} />
  if (!data) return <ErrorBanner message={`Job ${jobId} not found.`} />

  const title = data.job.slug || data.job.jobId

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-10 pt-8 rise rise-1">
        <BackLink to="/jobs" label="Jobs" />
      </div>

      <PageHeader
        title={title}
        right={
          <div className="flex items-center gap-3">
            <Pill tone={data.job.disabled ? 'destructive' : 'success'}>
              <StatusDot
                tone={data.job.disabled ? 'destructive' : 'success'}
                pulse={!data.job.disabled}
              />
              {data.job.disabled ? 'disabled' : 'enabled'}
            </Pill>
            <Pill tone="muted">{data.summary.kind}</Pill>
          </div>
        }
        meta={[
          { label: 'Project', value: data.job.projectId },
          { label: 'Agent', value: data.job.agentId },
          { label: 'Cron', value: data.schedule.cron },
          {
            label: 'Flow',
            value: data.flow ? `${data.flow.sequence.length} + ${data.flow.onFailure.length}` : '—',
          },
        ]}
      />

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 overflow-auto bg-background">
        <div className="px-10 py-10 rise rise-2">
          {activeTab === 'overview' && <JobOverviewTab data={data} />}
          {activeTab === 'startup' && <JobStartupTab data={data} />}
          {activeTab === 'schedule' && <JobScheduleTab data={data} />}
          {activeTab === 'flow' && <JobFlowTab data={data} />}
          {activeTab === 'runs' && <JobRunsTab data={data} />}
          {activeTab === 'raw' && <JobRawTab data={data} />}
        </div>
      </div>

      <ProvenanceStrip provenance={data.provenance} />
    </div>
  )
}
