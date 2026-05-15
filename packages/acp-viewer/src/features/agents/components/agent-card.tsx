import { Pill, StatusDot } from '@/components/primitives'
import { cn } from '@/lib/cn'
import type { AgentSummaryProfile } from '@/types/api'
import { ArrowUpRight } from 'lucide-react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { agentPersonality, hasPersonality } from '../personality'
import { AgentAvatar } from './agent-avatar'

interface AgentCardData {
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
 * Rolodex profile card — index-card silhouette with a personalised motif,
 * a watermark glyph, and a colour wash. Each card should read as a distinct
 * artifact: same skeleton, different paper stock.
 */
export function AgentCard({ row }: { row: AgentCardData }) {
  const personality = agentPersonality(row.agentId, row.profile)
  const tone = heartbeatTone(row.heartbeat)
  const registered = hasPersonality(row.agentId, row.profile)

  // Diagonal corner wash — agent colour pooling in the bottom-right.
  const cardStyle: CSSProperties = {
    borderColor: `${personality.color}55`,
    backgroundImage: [
      // Soft directional wash from bottom-right
      `radial-gradient(ellipse 80% 60% at 110% 110%, ${personality.color}26 0%, transparent 65%)`,
      // Subtle top-left vignette so the avatar reads
      `radial-gradient(ellipse 50% 40% at 0% 0%, ${personality.color}14 0%, transparent 70%)`,
    ].join(', '),
    backgroundBlendMode: 'normal, normal',
    boxShadow: `inset 0 0 0 1px ${personality.color}1A`,
    ['--card-hover-border' as string]: `${personality.color}AA`,
    ['--card-hover-shadow' as string]: `0 0 0 1px ${personality.color}66, 0 18px 36px -20px ${personality.color}80`,
  }

  const ruleStyle: CSSProperties = {
    background: `linear-gradient(90deg, ${personality.color} 0%, ${personality.color}66 70%, transparent 100%)`,
  }

  const tabStyle: CSSProperties = {
    background: personality.color,
    clipPath: 'polygon(0 0, 100% 0, 100% 100%)',
  }

  return (
    <Link
      to={`/agents/${encodeURIComponent(row.agentId)}`}
      style={cardStyle}
      className={cn(
        'group relative isolate flex flex-col h-full overflow-hidden',
        'bg-paper border rounded-[3px] p-6',
        'transition-[border-color,box-shadow,transform] duration-300',
        'hover:[border-color:var(--card-hover-border)] hover:[box-shadow:var(--card-hover-shadow)]',
        'hover:-translate-y-0.5',
        // Index-card top-right tab cut.
        '[clip-path:polygon(0_0,calc(100%-18px)_0,100%_18px,100%_100%,0_100%)]'
      )}
    >
      {/* Top-right tab — agent's gradient, not brass; brass becomes the registration tick inside */}
      <span
        aria-hidden="true"
        className="absolute top-0 right-0 w-[18px] h-[18px]"
        style={tabStyle}
      />

      {/* Paper grain over the top to soften the pattern */}
      <span
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='1' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 0.94  0 0 0 0 0.82  0 0 0 0.5 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
          mixBlendMode: 'soft-light',
        }}
      />

      {/* All content above the decorative layers */}
      <div className="relative z-10 flex flex-col h-full">
        {/* —— face up: identity + personality —— */}
        <div className="flex items-start gap-5">
          <AgentAvatar agentId={row.agentId} size="md" profile={row.profile} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="display text-[28px] text-ink leading-none tracking-[-0.02em] truncate">
                {row.displayName}
              </h3>
              <ArrowUpRight className="h-3.5 w-3.5 text-quiet/0 group-hover:text-accent transition-all shrink-0" />
            </div>
            {registered ? (
              <p
                className="display-italic text-[14px] leading-snug"
                style={{ color: personality.color }}
              >
                “{personality.tagline}”
              </p>
            ) : (
              <p className="text-[12px] text-quiet italic">unprofiled</p>
            )}
          </div>
        </div>

        {registered && personality.vibe.length > 0 && (
          <div className="mt-3 ml-[76px] mono text-[10.5px] tracking-[0.16em] uppercase text-muted">
            {personality.vibe.join(' · ')}
          </div>
        )}

        {/* —— rule —— */}
        <div className="mt-5 h-[1.5px] w-full" style={ruleStyle} />

        {/* —— spec sheet —— */}
        <dl className="mt-5 flex-1 grid grid-cols-[58px_minmax(0,1fr)] gap-x-4 gap-y-3 text-[12px]">
          {registered && (
            <>
              <SpecRow label="Role">
                <span className="text-ink">{personality.role}</span>
              </SpecRow>
              <SpecRow label="Model">
                <span className="mono text-ink">{personality.originatingModel}</span>
              </SpecRow>
              {personality.specialties.length > 0 && (
                <SpecRow label="Tags">
                  <SpecChips items={personality.specialties} color={personality.color} />
                </SpecRow>
              )}
            </>
          )}
          <SpecRow label="ID">
            <span className="mono text-ink truncate inline-block max-w-full align-middle">
              {row.agentId}
            </span>
          </SpecRow>
          <SpecRow label="Status">
            <span className="text-ink">{row.status}</span>
          </SpecRow>
        </dl>

        {/* —— footer chip strip —— */}
        <div className="mt-5 pt-4 border-t border-border/40 flex items-center justify-between gap-3">
          <div className="flex items-center gap-x-4 gap-y-1 text-[11px] mono tabular text-muted flex-wrap">
            <span>
              <span className="text-ink">{row.assignedJobsCount ?? '—'}</span> jobs
            </span>
            <span>
              <span className="text-ink">{row.membershipsCount ?? '—'}</span> memberships
            </span>
            {row.defaultProjectCount && row.defaultProjectCount > 0 ? (
              <span className="text-accent">default · {row.defaultProjectCount}</span>
            ) : null}
          </div>
          <Pill tone={tone}>
            <StatusDot tone={tone} pulse={row.heartbeat === 'alive'} />
            {row.heartbeat}
          </Pill>
        </div>
      </div>
    </Link>
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

function SpecChips({ items, color }: { items: string[]; color: string }) {
  const chipStyle: CSSProperties = {
    backgroundColor: `${color}1F`,
    borderColor: `${color}55`,
    color: color,
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {items.map((tag) => (
        <span
          key={tag}
          style={chipStyle}
          className="mono inline-flex items-center px-1.5 h-[18px] border rounded-[2px] text-[10px] tracking-wider lowercase font-medium leading-none whitespace-nowrap"
        >
          {tag}
        </span>
      ))}
    </span>
  )
}
