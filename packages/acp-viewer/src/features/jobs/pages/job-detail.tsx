import { ProvenanceStrip } from '@/components/provenance-strip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

export function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')

  const { data, isLoading, error } = useQuery({
    queryKey: ['job-detail', jobId],
    // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
    queryFn: () => getJobDetail(jobId!),
    enabled: !!jobId,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading job detail...
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

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-card">
        <div className="font-semibold text-sm text-foreground">{data.job.jobId}</div>
        <div className="text-xs text-muted">
          {data.summary.kind} &middot; {data.job.projectId} / {data.job.agentId}
        </div>
      </div>

      {/* Tabs */}
      <Tabs className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-4 mt-2 shrink-0">
          <TabsTrigger active={activeTab === 'overview'} onClick={() => setActiveTab('overview')}>
            Overview
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'startup'} onClick={() => setActiveTab('startup')}>
            Startup
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'schedule'} onClick={() => setActiveTab('schedule')}>
            Schedule
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'flow'} onClick={() => setActiveTab('flow')}>
            Flow
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'runs'} onClick={() => setActiveTab('runs')}>
            Runs
          </TabsTrigger>
          <TabsTrigger active={activeTab === 'raw'} onClick={() => setActiveTab('raw')}>
            Raw
          </TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-auto">
          {activeTab === 'overview' && (
            <TabsContent>
              <JobOverviewTab data={data} />
            </TabsContent>
          )}
          {activeTab === 'startup' && (
            <TabsContent>
              <JobStartupTab data={data} />
            </TabsContent>
          )}
          {activeTab === 'schedule' && (
            <TabsContent>
              <JobScheduleTab data={data} />
            </TabsContent>
          )}
          {activeTab === 'flow' && (
            <TabsContent>
              <JobFlowTab data={data} />
            </TabsContent>
          )}
          {activeTab === 'runs' && (
            <TabsContent>
              <JobRunsTab data={data} />
            </TabsContent>
          )}
          {activeTab === 'raw' && (
            <TabsContent>
              <JobRawTab data={data} />
            </TabsContent>
          )}
        </div>
      </Tabs>

      {/* Provenance at bottom */}
      <ProvenanceStrip provenance={data.provenance} />
    </div>
  )
}
