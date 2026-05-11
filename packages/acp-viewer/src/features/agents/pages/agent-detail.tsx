import { PageHeader } from '@/components/page-header'
import {
  BackLink,
  ErrorBanner,
  PageLoading,
  Pill,
  StatusDot,
  TabBar,
} from '@/components/primitives'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { heartbeatStatus } from '../agent-utils'
import { AgentHeartbeatTab } from '../components/agent-heartbeat-tab'
import { AgentJobsTab } from '../components/agent-jobs-tab'
import { AgentOverviewTab } from '../components/agent-overview-tab'
import { AgentProjectsTab } from '../components/agent-projects-tab'
import { AgentRawTab } from '../components/agent-raw-tab'
import { AgentScopeTargetsTab } from '../components/agent-scope-targets-tab'
import { fetchAgentDetail, fetchAgentHeartbeat } from '../data'

type AgentTab = 'overview' | 'projects' | 'jobs' | 'heartbeat' | 'scope' | 'raw'

const TABS: ReadonlyArray<{ id: AgentTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Projects' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'scope', label: 'Targets' },
  { id: 'raw', label: 'Raw' },
]

function hbTone(status: string): 'success' | 'destructive' | 'warn' | 'muted' {
  if (status === 'alive') return 'success'
  if (status === 'stale') return 'warn'
  if (status === 'dead' || status === 'down') return 'destructive'
  return 'muted'
}

export function AgentDetailPage() {
  const { agentId } = useParams()
  const [activeTab, setActiveTab] = useState<AgentTab>('overview')

  const detailQuery = useQuery({
    queryKey: ['agents', agentId, 'detail'],
    queryFn: () => fetchAgentDetail(agentId ?? ''),
    enabled: agentId !== undefined && agentId.length > 0,
  })
  const heartbeatQuery = useQuery({
    queryKey: ['agents', agentId, 'heartbeat'],
    queryFn: () => fetchAgentHeartbeat(agentId ?? ''),
    enabled: agentId !== undefined && agentId.length > 0,
    refetchInterval: 5_000,
  })

  if (agentId === undefined) return <ErrorBanner message="Missing agent id." />
  if (detailQuery.isLoading) return <PageLoading label="Loading" />
  if (detailQuery.error instanceof Error) return <ErrorBanner message={detailQuery.error.message} />
  if (detailQuery.data === undefined) return <ErrorBanner message={`Agent ${agentId} not found.`} />

  const detail = {
    ...detailQuery.data,
    heartbeat: heartbeatQuery.data ?? detailQuery.data.heartbeat,
  }
  const hb = heartbeatStatus(detail.heartbeat)
  const tone = hbTone(hb)

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-10 pt-8 rise rise-1">
        <BackLink to="/agents" label="Agents" />
      </div>

      <PageHeader
        title={detail.agent.displayName}
        right={
          <Pill tone={tone}>
            <StatusDot tone={tone} pulse={hb === 'alive'} />
            {hb}
          </Pill>
        }
        meta={[
          { label: 'ID', value: detail.agent.agentId },
          { label: 'Status', value: detail.agent.status },
          { label: 'Memberships', value: detail.memberships.length },
          { label: 'Jobs', value: detail.jobs.length },
        ]}
      />

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 overflow-auto bg-background">
        <div className="px-10 py-10 rise rise-2">
          {activeTab === 'overview' && <AgentOverviewTab detail={detail} />}
          {activeTab === 'projects' && <AgentProjectsTab detail={detail} />}
          {activeTab === 'jobs' && <AgentJobsTab detail={detail} />}
          {activeTab === 'heartbeat' && (
            <AgentHeartbeatTab detail={detail} loading={heartbeatQuery.isLoading} />
          )}
          {activeTab === 'scope' && <AgentScopeTargetsTab detail={detail} />}
          {activeTab === 'raw' && <AgentRawTab detail={detail} />}
        </div>
      </div>
    </div>
  )
}
