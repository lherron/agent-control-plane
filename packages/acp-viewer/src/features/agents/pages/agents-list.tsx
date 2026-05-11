import { PageHeader } from '@/components/page-header'
import { EmptyState, ErrorBanner, PageLoading, Pill, StatusDot } from '@/components/primitives'
import type { AgentSummary } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Cpu } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { heartbeatStatus } from '../agent-utils'
import { fetchAgentDetail, fetchAgents } from '../data'

interface AgentRow extends AgentSummary {
  membershipsCount: number | undefined
  defaultProjectCount: number | undefined
  assignedJobsCount: number | undefined
  heartbeat: string
}

async function fetchAgentsWithRollups(): Promise<AgentRow[]> {
  const agents = await fetchAgents()
  const details = await Promise.all(
    agents.map((a) => fetchAgentDetail(a.agentId).catch(() => undefined))
  )
  return agents.map((agent, i) => {
    const detail = details[i]
    return {
      ...agent,
      membershipsCount: detail?.memberships.length,
      defaultProjectCount: detail?.memberships.filter((m) => m.isDefaultAgent).length,
      assignedJobsCount: detail?.jobs.length,
      heartbeat: heartbeatStatus(detail?.heartbeat),
    }
  })
}

function heartbeatTone(status: string): 'success' | 'destructive' | 'warn' | 'muted' {
  if (status === 'alive') return 'success'
  if (status === 'stale') return 'warn'
  if (status === 'dead' || status === 'down') return 'destructive'
  return 'muted'
}

const GRID = '14px minmax(220px,1.3fr) 130px 80px 70px 90px 14px'

export function AgentsListPage() {
  const query = useQuery({ queryKey: ['agents', 'with-rollups'], queryFn: fetchAgentsWithRollups })
  const rows = useMemo<AgentRow[]>(
    () => (query.data ?? []).slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [query.data]
  )

  if (query.isLoading) return <PageLoading label="Loading" />
  if (query.error instanceof Error) return <ErrorBanner message={query.error.message} />

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Agents"
        meta={[
          { label: 'Configured', value: rows.length },
          { label: 'Alive', value: rows.filter((r) => r.heartbeat === 'alive').length },
        ]}
      />

      <div className="flex-1 px-10 py-8 rise rise-2">
        {rows.length === 0 ? (
          <EmptyState icon={<Cpu className="h-8 w-8" />} title="No agents" />
        ) : (
          <>
            <div
              style={{ gridTemplateColumns: GRID }}
              className="grid items-center gap-x-6 pb-2 border-b border-border/60"
            >
              {[null, 'Agent', 'ID', 'Projects', 'Jobs', 'Heartbeat', null].map((label, i) => (
                <span key={label ?? `_${i}`} className="kicker text-muted truncate">
                  {label ?? ''}
                </span>
              ))}
            </div>

            <ul>
              {rows.map((agent) => {
                const hbTone = heartbeatTone(agent.heartbeat)
                return (
                  <li key={agent.agentId}>
                    <Link
                      to={`/agents/${encodeURIComponent(agent.agentId)}`}
                      style={{ gridTemplateColumns: GRID }}
                      className="grid items-center gap-x-6 py-3 group border-b border-border/40 transition-colors hover:bg-paper/40"
                    >
                      <StatusDot tone={hbTone} pulse={agent.heartbeat === 'alive'} />
                      <div className="min-w-0">
                        <div className="text-[14px] text-ink font-medium truncate group-hover:text-accent">
                          {agent.displayName}
                        </div>
                        {agent.defaultProjectCount && agent.defaultProjectCount > 0 ? (
                          <div className="mono text-[10px] text-accent">
                            default for {agent.defaultProjectCount}
                          </div>
                        ) : null}
                      </div>
                      <span className="mono text-[12px] text-muted truncate">{agent.agentId}</span>
                      <span className="mono text-[12px] tabular text-ink">
                        {agent.membershipsCount ?? '…'}
                      </span>
                      <span className="mono text-[12px] tabular text-ink">
                        {agent.assignedJobsCount ?? '…'}
                      </span>
                      <Pill tone={hbTone}>{agent.heartbeat}</Pill>
                      <ArrowUpRight className="h-3.5 w-3.5 text-quiet/0 group-hover:text-accent transition-all" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
