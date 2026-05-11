import { cn } from '@/lib/cn'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/* ─── Pills ────────────────────────────────────────────────── */

type PillTone = 'neutral' | 'accent' | 'success' | 'warn' | 'destructive' | 'muted' | 'ink'

const PILL_TONE: Record<PillTone, string> = {
  neutral: 'bg-paper text-ink border-border',
  accent: 'bg-[#3a2d18] text-[#f0c483] border-[#5a4520]',
  success: 'bg-[#1c3329] text-[#7ad6a8] border-[#2d5c43]',
  warn: 'bg-[#3a3017] text-[#f0d885] border-[#5a4a20]',
  destructive: 'bg-[#3a1d24] text-[#f7a5b8] border-[#5a2c38]',
  muted: 'bg-secondary text-muted border-border',
  ink: 'bg-ink text-background border-ink',
}

export function Pill({
  tone = 'neutral',
  children,
  className,
  mono = false,
}: {
  tone?: PillTone
  children: ReactNode
  className?: string
  mono?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-[18px] border rounded-[2px] text-[10px] tracking-wider uppercase font-medium leading-none whitespace-nowrap',
        mono && 'mono normal-case tracking-normal',
        PILL_TONE[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/* ─── Status dot ──────────────────────────────────────────── */

export function StatusDot({
  tone = 'neutral',
  pulse = false,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'destructive' | 'muted'
  pulse?: boolean
  className?: string
}) {
  const bg = {
    neutral: 'bg-muted',
    muted: 'bg-quiet',
    accent: 'bg-accent',
    success: 'bg-[#4eb88a]',
    warn: 'bg-[#e6c463]',
    destructive: 'bg-[#ef6483]',
  }[tone]
  return (
    <span className={cn('relative inline-flex h-2 w-2', className)}>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping',
            bg
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', bg)} />
    </span>
  )
}

/* ─── Back link ───────────────────────────────────────────── */

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-2 text-[11px] text-muted hover:text-ink transition-colors"
    >
      <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
      <span className="kicker">{label}</span>
    </Link>
  )
}

/* ─── Tab bar — editorial underline style ────────────────── */

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; hint?: string }>
  active: T
  onChange: (id: T) => void
  className?: string
}) {
  return (
    <div
      className={cn('flex items-center gap-6 border-b border-border/60 px-10', className)}
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
              'relative py-3 text-[13px] transition-colors',
              isActive ? 'text-ink font-medium' : 'text-muted hover:text-ink'
            )}
          >
            {tab.label}
            {isActive && (
              <span className="absolute -bottom-px left-0 right-0 h-[1.5px] bg-accent" />
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ─── Field row — for "spec sheet" detail panels ─────────── */

export function FieldRow({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-6 py-3 border-b border-border/40 last:border-0">
      <dt className="kicker text-muted pt-0.5">{label}</dt>
      <dd className="text-[13px] text-ink min-w-0 break-words">
        {children}
        {hint && <span className="block mt-0.5 text-[11px] text-muted">{hint}</span>}
      </dd>
    </div>
  )
}

/* ─── Section header — used inside pages ─────────────────── */

export function SectionHeader({
  title,
  description,
  right,
}: {
  /** Deprecated — no longer rendered. Kept for prop compat. */
  index?: string
  title: ReactNode
  description?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 mb-5">
      <div>
        <h2 className="kicker text-ink">{title}</h2>
        {description && <p className="mt-1 text-[12px] text-muted">{description}</p>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

/* ─── Empty state ────────────────────────────────────────── */

export function EmptyState({
  title,
  description,
  icon,
}: {
  title: string
  description?: string
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3">
      {icon && <div className="text-muted/60">{icon}</div>}
      <div className="display text-[18px] text-ink">{title}</div>
      {description && <p className="text-[12px] text-muted max-w-sm">{description}</p>}
    </div>
  )
}

/* ─── Loading state ──────────────────────────────────────── */

export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-20 gap-3 fade">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 bg-accent rounded-full animate-pulse" />
        <span
          className="h-2 w-2 bg-accent rounded-full animate-pulse"
          style={{ animationDelay: '120ms' }}
        />
        <span
          className="h-2 w-2 bg-accent rounded-full animate-pulse"
          style={{ animationDelay: '240ms' }}
        />
      </div>
      <div className="kicker text-muted">{label}</div>
    </div>
  )
}

/* ─── Error banner ───────────────────────────────────────── */

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mx-8 my-6 p-4 border border-destructive/40 bg-[#3a1d24]/60 rounded-[3px]">
      <div className="kicker text-[#f7a5b8] mb-1">Fetch error</div>
      <div className="mono text-[12px] text-[#f7a5b8]">{message}</div>
    </div>
  )
}
