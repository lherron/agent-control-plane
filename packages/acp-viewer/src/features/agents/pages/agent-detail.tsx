import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Bot } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AgentHeartbeatTab } from '../components/agent-heartbeat-tab'
import { AgentJobsTab } from '../components/agent-jobs-tab'
import { AgentOverviewTab } from '../components/agent-overview-tab'
import { AgentProjectsTab } from '../components/agent-projects-tab'
import { AgentRawTab } from '../components/agent-raw-tab'
import { AgentScopeTargetsTab } from '../components/agent-scope-targets-tab'
import { fetchAgentDetail, fetchAgentHeartbeat } from '../data'

const tabs = ['Overview', 'Projects', 'Jobs', 'Heartbeat', 'Scope Targets', 'Raw'] as const
type AgentTab = (typeof tabs)[number]

export function AgentDetailPage() {
  const { agentId } = useParams()
  const [activeTab, setActiveTab] = useState<AgentTab>('Overview')
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

  if (agentId === undefined) {
    return <div className="p-6 text-destructive">Missing agent id.</div>
  }

  if (detailQuery.isLoading) {
    return <div className="p-6 text-muted">Loading agent...</div>
  }

  if (detailQuery.error instanceof Error) {
    return <div className="p-6 text-destructive">{detailQuery.error.message}</div>
  }

  if (detailQuery.data === undefined) {
    return <div className="p-6 text-muted">Agent not found.</div>
  }

  const detail = {
    ...detailQuery.data,
    heartbeat: heartbeatQuery.data ?? detailQuery.data.heartbeat,
  }

  return (
    <div className="p-6 space-y-5">
      <Link
        to="/agents"
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-accent"
      >
        <ArrowLeft className="h-4 w-4" />
        Agents
      </Link>

      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-selected text-selected-foreground">
          <Bot className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{detail.agent.displayName}</h1>
          <p className="font-mono text-xs text-muted">{detail.agent.agentId}</p>
        </div>
      </header>

      <Tabs>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} active={activeTab === tab} onClick={() => setActiveTab(tab)}>
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent>
          {activeTab === 'Overview' ? <AgentOverviewTab detail={detail} /> : null}
          {activeTab === 'Projects' ? <AgentProjectsTab detail={detail} /> : null}
          {activeTab === 'Jobs' ? <AgentJobsTab detail={detail} /> : null}
          {activeTab === 'Heartbeat' ? (
            <AgentHeartbeatTab detail={detail} loading={heartbeatQuery.isLoading} />
          ) : null}
          {activeTab === 'Scope Targets' ? <AgentScopeTargetsTab detail={detail} /> : null}
          {activeTab === 'Raw' ? <AgentRawTab detail={detail} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}
