import { Pill, StatusDot } from '@/components/primitives'
import type { AgentSummaryProfile } from '@/types/api'
import { ArrowUpRight } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { agentPersonality } from '../personality'
import type { AgentPersonality } from '../personality'
import { AgentAvatar } from './agent-avatar'

interface AgentEntryData {
  agentId: string
  displayName: string
  status: string
  heartbeat: string
  membershipsCount: number | undefined
  defaultProjectCount: number | undefined
  assignedJobsCount: number | undefined
  profile?: AgentSummaryProfile | undefined
}

function heartbeatTone(status: string): 'success' | 'destructive' | 'warn' | 'muted' {
  if (status === 'alive') return 'success'
  if (status === 'stale') return 'warn'
  if (status === 'dead' || status === 'down') return 'destructive'
  return 'muted'
}

/**
 * Editorial entry — full-width band, large PFP, poster-scale name. Each agent
 * is an exhibition subject; the page is the catalogue.
 *
 * Mobile layout: PFP and name+tagline form a byline row; spec block flows
 * full-width beneath. Desktop layout: PFP on the left, everything stacks in
 * the content column beside it.
 */
export function AgentEntry({
  row,
  index,
  total,
}: {
  row: AgentEntryData
  index: number
  total: number
}) {
  const personality = agentPersonality(row.agentId, row.profile, row.displayName)
  const tone = heartbeatTone(row.heartbeat)
  const num = String(index + 1).padStart(2, '0')
  const tot = String(total).padStart(2, '0')

  const ruleStyle: CSSProperties = {
    background: `linear-gradient(90deg, ${personality.color} 0%, ${personality.color}55 70%, transparent 100%)`,
  }
  const spineStyle: CSSProperties = {
    background: `linear-gradient(180deg, transparent 0%, ${personality.color}88 10%, ${personality.color} 50%, ${personality.color}88 90%, transparent 100%)`,
  }
  const hoverStyle: CSSProperties = {
    ['--entry-tint' as string]: `${personality.color}08`,
  }

  return (
    <Link
      to={`/agents/${encodeURIComponent(row.agentId)}`}
      style={hoverStyle}
      className="group relative block py-10 md:py-14 transition-colors hover:[background:var(--entry-tint)]"
    >
      {/* Left signature-color spine — fades in on hover */}
      <span
        aria-hidden="true"
        style={spineStyle}
        className="absolute left-0 top-14 bottom-14 w-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500"
      />

      {/* Number & status — top edge */}
      <div className="flex items-baseline justify-between mb-8 lg:mb-10">
        <div className="flex items-baseline gap-3">
          <span className="display text-accent text-[40px] lg:text-[44px] leading-none tracking-[-0.02em]">
            {num}
          </span>
          <span className="mono text-[11px] tabular text-quiet">/ {tot}</span>
        </div>
        <div className="flex items-center gap-4">
          <Pill tone={tone}>
            <StatusDot tone={tone} pulse={row.heartbeat === 'alive'} />
            {row.heartbeat}
          </Pill>
          <ArrowUpRight className="h-4 w-4 text-quiet/40 group-hover:text-accent transition-colors" />
        </div>
      </div>

      {/* Mobile/tablet — PFP sits beside name+tagline as a byline row */}
      <div className="flex items-start gap-5 mb-8 lg:hidden">
        <AgentAvatar
          agentId={row.agentId}
          size="lg"
          className="shrink-0"
          profile={row.profile}
          displayName={row.displayName}
        />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="display text-ink leading-[0.95] tracking-[-0.03em] text-[clamp(36px,10vw,56px)] break-words">
            {row.displayName}
          </h2>
          <p
            className="display-italic mt-3 text-[17px] leading-[1.25] max-w-[28ch]"
            style={{ color: personality.color }}
          >
            “{personality.tagline}”
          </p>
        </div>
      </div>

      {/* Mobile/tablet — spec block flows full-width below the byline row */}
      <div className="lg:hidden">
        <SpecBlock row={row} personality={personality} ruleStyle={ruleStyle} />
      </div>

      {/* Desktop — PFP and full content column side-by-side */}
      <div className="hidden lg:flex lg:items-start lg:gap-16">
        <AgentAvatar
          agentId={row.agentId}
          size="xl"
          className="shrink-0"
          profile={row.profile}
          displayName={row.displayName}
        />
        <div className="min-w-0 flex-1 pt-2">
          <h2 className="display text-ink leading-[0.92] tracking-[-0.03em] text-[clamp(64px,7vw,104px)] break-words">
            {row.displayName}
          </h2>
          <p
            className="display-italic mt-6 text-[26px] leading-[1.15] max-w-[36ch]"
            style={{ color: personality.color }}
          >
            “{personality.tagline}”
          </p>
          <SpecBlock row={row} personality={personality} ruleStyle={ruleStyle} />
        </div>
      </div>
    </Link>
  )
}

/* ─── Shared rule + vibe + role + spec block ──────────────── */

function SpecBlock({
  row,
  personality,
  ruleStyle,
}: {
  row: AgentEntryData
  personality: AgentPersonality
  ruleStyle: CSSProperties
}) {
  return (
    <>
      <div className="mt-7 lg:mt-8 h-[1.5px] w-24" style={ruleStyle} />

      {personality.vibe.length > 0 && (
        <div className="mt-7 lg:mt-8 mono text-[11.5px] lg:text-[12px] tracking-[0.22em] uppercase text-muted">
          {personality.vibe.join('   ·   ')}
        </div>
      )}

      <p
        className="mt-4 lg:mt-5 text-[14px] text-ink-soft italic"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {personality.role}
      </p>

      <dl className="mt-8 lg:mt-10 grid grid-cols-[60px_minmax(0,1fr)] sm:grid-cols-[72px_minmax(0,1fr)] gap-x-5 sm:gap-x-6 gap-y-2.5 max-w-[640px]">
        <SpecRow label="Model">
          <span className="mono text-[12.5px] text-ink">{personality.originatingModel}</span>
        </SpecRow>
        <SpecRow label="ID">
          <span className="mono text-[12.5px] text-ink">{row.agentId}</span>
        </SpecRow>
        {personality.specialties.length > 0 && (
          <SpecRow label="Tags">
            <span className="mono text-[12.5px] text-ink">
              {personality.specialties.join('  ·  ')}
            </span>
          </SpecRow>
        )}
        <SpecRow label="Ops">
          <span className="mono text-[12.5px] tabular text-ink">
            {row.assignedJobsCount ?? '—'} jobs · {row.membershipsCount ?? '—'} memberships
            {row.defaultProjectCount && row.defaultProjectCount > 0 ? (
              <span className="text-accent"> · default · {row.defaultProjectCount}</span>
            ) : null}
          </span>
        </SpecRow>
      </dl>
    </>
  )
}

/**
 * Stub entry — short, quiet, single line. Used for agents without a profile.
 * Visually subordinates them to the profiled set without hiding them.
 */
export function AgentEntryStub({ row }: { row: AgentEntryData }) {
  const tone = heartbeatTone(row.heartbeat)
  const initial = row.displayName.trim().charAt(0).toUpperCase() || '?'
  return (
    <Link
      to={`/agents/${encodeURIComponent(row.agentId)}`}
      className="group flex items-center gap-3 sm:gap-6 py-3.5 border-b border-border/30 transition-colors hover:bg-paper/30"
    >
      <AgentAvatar
        agentId={row.agentId}
        size="sm"
        monogram={initial}
        forceMonogram
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-ink-soft font-medium truncate group-hover:text-ink">
          {row.displayName}
        </div>
        <div className="mono text-[10px] text-quiet/80 tracking-[0.1em] uppercase mt-0.5 truncate">
          <span className="sm:hidden">{row.agentId}</span>
          <span className="hidden sm:inline">awaiting profile</span>
        </div>
      </div>
      <span className="hidden md:inline mono text-[12px] text-muted truncate min-w-0 max-w-[200px]">
        {row.agentId}
      </span>
      <span className="hidden sm:inline mono text-[11px] tabular text-muted">{row.status}</span>
      <Pill tone={tone}>{row.heartbeat}</Pill>
    </Link>
  )
}

function SpecRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="kicker text-muted pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}
