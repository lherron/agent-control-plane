import { BackLink, ErrorBanner, PageLoading, Pill, StatusDot } from '@/components/primitives'
import { cn } from '@/lib/cn'
import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { heartbeatStatus } from '../agent-utils'
import { AgentAvatar } from '../components/agent-avatar'
import { AgentHeartbeatTab } from '../components/agent-heartbeat-tab'
import { AgentJobsTab } from '../components/agent-jobs-tab'
import { AgentOverviewTab } from '../components/agent-overview-tab'
import { AgentProjectsTab } from '../components/agent-projects-tab'
import { AgentRawTab } from '../components/agent-raw-tab'
import { AgentScopeTargetsTab } from '../components/agent-scope-targets-tab'
import { fetchAgentDetail, fetchAgentHeartbeat } from '../data'
import { agentPersonality, hasPersonality } from '../personality'

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
  const personality = agentPersonality(
    detail.agent.agentId,
    detail.agent.profile,
    detail.agent.displayName
  )
  const profiled = hasPersonality(detail.agent.agentId, detail.agent.profile)

  return (
    <div className="flex min-h-full flex-col">
      <AgentDossierHeader
        agentId={detail.agent.agentId}
        displayName={detail.agent.displayName}
        status={detail.agent.status}
        heartbeat={hb}
        heartbeatTone={tone}
        jobsCount={detail.jobs.length}
        membershipsCount={detail.memberships.length}
        scopeTargetsCount={detail.scopeTargets.length}
        profile={detail.agent.profile}
        profiled={profiled}
      />

      <AgentDossierTabs
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
        color={personality.color}
      />

      <div className="flex-1 bg-background">
        <div className="mx-auto w-full max-w-[1120px] px-5 sm:px-8 md:px-10 py-10 md:py-12 rise rise-2">
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

interface AgentDossierHeaderProps {
  agentId: string
  displayName: string
  status: string
  heartbeat: string
  heartbeatTone: 'success' | 'destructive' | 'warn' | 'muted'
  jobsCount: number
  membershipsCount: number
  scopeTargetsCount: number
  profile: Parameters<typeof agentPersonality>[1]
  profiled: boolean
}

function AgentDossierHeader({
  agentId,
  displayName,
  status,
  heartbeat,
  heartbeatTone,
  jobsCount,
  membershipsCount,
  scopeTargetsCount,
  profile,
  profiled,
}: AgentDossierHeaderProps) {
  const personality = agentPersonality(agentId, profile, displayName)
  const headerStyle: CSSProperties = {
    ['--agent-color' as string]: personality.color,
    backgroundImage: [
      `linear-gradient(115deg, ${personality.color}16 0%, transparent 42%)`,
      `radial-gradient(ellipse 600px 260px at 82% 10%, ${personality.color}18 0%, transparent 70%)`,
    ].join(', '),
  }
  const ruleStyle: CSSProperties = {
    background: `linear-gradient(90deg, ${personality.color} 0%, ${personality.color}66 68%, transparent 100%)`,
  }

  return (
    <header
      style={headerStyle}
      className="relative isolate overflow-hidden border-b border-border-strong/60"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.18] line-grid pointer-events-none"
      />
      <div className="relative mx-auto w-full max-w-[1120px] px-5 sm:px-8 md:px-10 pt-7 md:pt-9 pb-10 md:pb-14">
        <div className="flex items-center justify-between gap-6 rise rise-1">
          <BackLink to="/agents" label="Agent catalogue" />
          <InlineRegistrationMark color={personality.color} />
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[288px_minmax(0,1fr)] lg:gap-16 lg:items-start rise rise-2">
          <div className="flex items-start gap-5 lg:block">
            <AgentAvatar
              agentId={agentId}
              size="lg"
              profile={profile}
              displayName={displayName}
              className="lg:hidden"
            />
            <AgentAvatar
              agentId={agentId}
              size="xl"
              profile={profile}
              displayName={displayName}
              className="hidden lg:inline-grid"
            />
            <SignatureTicks color={personality.color} />
            <div className="min-w-0 flex-1 lg:mt-8 lg:flex lg:items-center lg:justify-between lg:gap-4">
              <div>
                <div className="kicker text-accent">A·C·P · agent dossier</div>
                <div className="mt-2 mono text-[11px] tabular text-muted break-all">{agentId}</div>
              </div>
              <Pill tone={heartbeatTone} className="mt-4 lg:mt-0">
                <StatusDot tone={heartbeatTone} pulse={heartbeat === 'alive'} />
                {heartbeat}
              </Pill>
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span
                className="mono text-[11px] uppercase tracking-[0.18em]"
                style={{ color: personality.color }}
              >
                {profiled ? 'profiled' : 'awaiting profile'}
              </span>
              <span className="h-px w-12 bg-border-strong/80" />
              <span className="mono text-[11px] uppercase tracking-[0.18em] text-muted">
                {status}
              </span>
            </div>

            <h1 className="mt-5 display text-ink leading-[0.9] tracking-[-0.03em] text-[clamp(52px,13vw,92px)] lg:text-[clamp(84px,8.4vw,140px)] break-words">
              {displayName}
            </h1>

            <p
              className="display-italic mt-6 text-[24px] md:text-[30px] leading-[1.12] max-w-[34ch]"
              style={{ color: personality.color }}
            >
              “{personality.tagline}”
            </p>

            <div className="mt-8 h-[1.5px] w-32" style={ruleStyle} />

            <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
              <div>
                {personality.vibe.length > 0 && (
                  <div className="mono text-[11.5px] tracking-[0.22em] uppercase text-muted">
                    {personality.vibe.join('   ·   ')}
                  </div>
                )}
                <p
                  className="mt-4 text-[15px] leading-[1.5] text-ink-soft italic max-w-[54ch]"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  {personality.role}
                </p>
                <dl className="mt-7 grid grid-cols-[68px_minmax(0,1fr)] gap-x-5 gap-y-2.5 max-w-[640px]">
                  <SpecRow label="Model">
                    <span className="mono text-[12.5px] text-ink">
                      {personality.originatingModel}
                    </span>
                  </SpecRow>
                  {personality.specialties.length > 0 && (
                    <SpecRow label="Tags">
                      <span className="mono text-[12.5px] text-ink">
                        {personality.specialties.join('  ·  ')}
                      </span>
                    </SpecRow>
                  )}
                </dl>
              </div>

              <dl className="grid grid-cols-3 gap-x-8 gap-y-4 sm:flex sm:justify-start xl:justify-end xl:gap-x-10">
                <DossierStat label="Projects" value={membershipsCount} />
                <DossierStat label="Jobs" value={jobsCount} />
                <DossierStat label="Targets" value={scopeTargetsCount} />
              </dl>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

function InlineRegistrationMark({ color }: { color: string }) {
  return (
    <div className="hidden sm:flex items-center gap-2 w-[180px]" aria-hidden="true">
      <span className="h-px flex-1 bg-border-strong/70" />
      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="h-px w-10" style={{ backgroundColor: color }} />
      <span className="h-1.5 w-8 border-y border-border-strong/70" />
    </div>
  )
}

function SignatureTicks({ color }: { color: string }) {
  return (
    <div
      className="mt-5 hidden lg:grid grid-cols-[1fr_24px_1fr] items-center gap-3"
      aria-hidden="true"
    >
      <span className="h-px bg-border-strong/60" />
      <span
        className="h-1.5"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${color} 28%, ${color} 72%, transparent 100%)`,
        }}
      />
      <span className="h-px bg-border-strong/60" />
    </div>
  )
}

function AgentDossierTabs<T extends string>({
  tabs,
  active,
  onChange,
  color,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>
  active: T
  onChange: (id: T) => void
  color: string
}) {
  const style: CSSProperties = {
    ['--agent-color' as string]: color,
  }

  return (
    <div className="border-b border-border/60 bg-background/80 backdrop-blur-sm">
      <div
        style={style}
        className="mx-auto flex w-full max-w-[1120px] items-center gap-5 overflow-x-auto px-5 sm:px-8 md:px-10"
        role="tablist"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative shrink-0 py-4 text-[13px] transition-colors',
                isActive ? 'text-ink font-medium' : 'text-muted hover:text-ink'
              )}
            >
              {tab.label}
              <span
                className={cn(
                  'absolute -bottom-px left-0 right-0 h-[1.5px] transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0'
                )}
                style={{ backgroundColor: 'var(--agent-color)' }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="kicker text-muted pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function DossierStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="kicker text-muted">{label}</dt>
      <dd className="display mt-2 text-[44px] leading-none tracking-[-0.02em] text-ink tabular-nums">
        {String(value).padStart(2, '0')}
      </dd>
    </div>
  )
}
