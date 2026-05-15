import { EmptyState, ErrorBanner, PageLoading } from '@/components/primitives'
import type { AgentSummary } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { Cpu } from 'lucide-react'
import { useMemo } from 'react'
import { heartbeatStatus } from '../agent-utils'
import { AgentEntry, AgentEntryStub } from '../components/agent-entry'
import { fetchAgentDetail, fetchAgents } from '../data'
import { hasPersonality } from '../personality'

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

export function AgentsGlamProposalPage() {
  const query = useQuery({ queryKey: ['agents', 'glam-proposal'], queryFn: fetchAgentsWithRollups })
  const rows = useMemo<AgentRow[]>(
    () =>
      (query.data ?? []).slice().sort((a, b) => {
        const aReg = hasPersonality(a.agentId)
        const bReg = hasPersonality(b.agentId)
        if (aReg !== bReg) return aReg ? -1 : 1
        return a.displayName.localeCompare(b.displayName)
      }),
    [query.data]
  )

  if (query.isLoading) return <PageLoading label="Loading proposal" />
  if (query.error instanceof Error) return <ErrorBanner message={query.error.message} />

  const profiled = rows.filter((r) => hasPersonality(r.agentId))
  const awaiting = rows.filter((r) => !hasPersonality(r.agentId))

  return (
    <div className="flex flex-col min-h-full">
      <Masthead profiled={profiled.length} total={rows.length} />

      {rows.length === 0 ? (
        <EmptyState icon={<Cpu className="h-8 w-8" />} title="No agents" />
      ) : (
        <article className="mx-auto w-full max-w-[1120px] px-5 sm:px-8 md:px-10 pb-24 md:pb-32">
          {/* —— Profiled roster (the catalogue) —— */}
          {profiled.length > 0 && (
            <section>
              {profiled.map((row, i) => (
                <div
                  key={row.agentId}
                  className="rise relative"
                  style={{ animationDelay: `${120 + i * 90}ms` }}
                >
                  <BrassRule />
                  <AgentEntry row={row} index={i} total={profiled.length} />
                </div>
              ))}
              <BrassRule />
            </section>
          )}

          {/* —— Awaiting profile (stubs) —— */}
          {awaiting.length > 0 && (
            <section className="mt-32 rise" style={{ animationDelay: '600ms' }}>
              <AwaitingHeader count={awaiting.length} />
              <ul>
                {awaiting.map((row) => (
                  <li key={row.agentId}>
                    <AgentEntryStub row={row} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}
    </div>
  )
}

/* ─── Masthead — quieter; lets the content carry the page ─── */

function Masthead({ profiled, total }: { profiled: number; total: number }) {
  return (
    <header className="mx-auto w-full max-w-[1120px] px-5 sm:px-8 md:px-10 pt-14 md:pt-20 pb-10 md:pb-12 rise">
      <div className="kicker text-accent mb-4 md:mb-5">A·C·P · agent catalogue · draft</div>
      <h1 className="display text-ink leading-[0.9] tracking-[-0.03em] text-[clamp(48px,13vw,80px)] md:text-[clamp(72px,9vw,140px)] break-words">
        The collective,
        <br />
        <span className="display-italic text-accent">on the record.</span>
      </h1>
      <div className="mt-10 md:mt-12 flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)] lg:gap-x-16 lg:items-end">
        <p className="text-[14px] text-muted leading-[1.55] max-w-[44ch]">
          Six personalities. One brass canon. Each agent is presented as an exhibition entry —
          portrait set large, name set larger, voice and role recorded beneath. The catalogue is
          alphabetical. Profiled agents come first; the rest await their portrait.
        </p>
        <dl className="flex justify-start lg:justify-end gap-x-10 lg:gap-x-14">
          <Stat label="Profiled" value={profiled} />
          <Stat label="Roster" value={total} />
        </dl>
      </div>
    </header>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <dt className="kicker text-muted">{label}</dt>
      <dd className="display text-ink text-[44px] leading-none tracking-[-0.02em] mt-2">
        {String(value).padStart(2, '0')}
      </dd>
    </div>
  )
}

function BrassRule() {
  return <div className="h-px w-full bg-border-strong/70" />
}

function AwaitingHeader({ count }: { count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-6 mb-6 pb-3 border-b border-border/40">
      <div className="flex items-baseline gap-4">
        <span className="mono text-[11px] tabular text-accent">
          {String(count).padStart(2, '0')}
        </span>
        <h2 className="display text-[22px] text-ink leading-none">Awaiting profile</h2>
      </div>
      <span className="kicker text-muted">Roster · unattributed</span>
    </div>
  )
}
