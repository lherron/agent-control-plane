import { cn } from '@/lib/cn'
import { BellRing, FileText } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

export type PromptZoneTone = 'system' | 'reminder'

interface PromptZoneFrameProps {
  tone: PromptZoneTone
  eyebrow: string
  title: ReactNode
  right?: ReactNode
  stats?: Array<{ label: string; value: ReactNode }>
  children: ReactNode
  footer?: ReactNode
}

const ZONE_STYLES: Record<PromptZoneTone, CSSProperties> = {
  system: {
    ['--prompt-zone-color' as string]: '#e3a857',
    ['--prompt-zone-soft' as string]: 'rgba(227, 168, 87, 0.12)',
    ['--prompt-zone-border' as string]: 'rgba(227, 168, 87, 0.38)',
    ['--prompt-zone-shadow' as string]: 'rgba(227, 168, 87, 0.16)',
  },
  reminder: {
    ['--prompt-zone-color' as string]: '#b39cff',
    ['--prompt-zone-soft' as string]: 'rgba(179, 156, 255, 0.12)',
    ['--prompt-zone-border' as string]: 'rgba(179, 156, 255, 0.34)',
    ['--prompt-zone-shadow' as string]: 'rgba(179, 156, 255, 0.13)',
  },
}

export function PromptControlStrip({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4 border border-border/70 bg-paper/35 px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.16)]">
      {children}
    </div>
  )
}

export function PromptZoneFrame({
  tone,
  eyebrow,
  title,
  right,
  stats = [],
  children,
  footer,
}: PromptZoneFrameProps) {
  const Icon = tone === 'system' ? FileText : BellRing

  return (
    <section
      style={ZONE_STYLES[tone]}
      className="relative overflow-hidden border border-[color:var(--prompt-zone-border)] bg-paper/45 shadow-[0_26px_90px_rgba(0,0,0,0.22)]"
    >
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px] bg-[color:var(--prompt-zone-color)] shadow-[0_0_24px_var(--prompt-zone-shadow)]"
      />
      <div
        className="relative border-b border-[color:var(--prompt-zone-border)] px-5 py-5 md:px-6"
        style={{
          background:
            'linear-gradient(110deg, var(--prompt-zone-soft) 0%, rgba(34, 28, 47, 0.42) 44%, transparent 100%)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center border border-[color:var(--prompt-zone-border)] bg-[color:var(--prompt-zone-soft)] text-[color:var(--prompt-zone-color)] shadow-[inset_0_0_0_1px_rgba(240,232,221,0.05)]">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="kicker text-[color:var(--prompt-zone-color)]">{eyebrow}</div>
              <h2 className="display mt-2 text-[30px] leading-none text-ink md:text-[34px]">
                {title}
              </h2>
            </div>
          </div>
          {right && <div className="shrink-0 pt-1">{right}</div>}
        </div>

        {stats.length > 0 && (
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {stats.map((stat) => (
              <div
                key={String(stat.label)}
                className="border-t border-[color:var(--prompt-zone-border)] pt-3"
              >
                <div className="kicker text-muted">{stat.label}</div>
                <div className="mono mt-1 text-[12px] text-ink">{stat.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="relative">{children}</div>
      {footer && (
        <div className="border-t border-[color:var(--prompt-zone-border)] bg-background/18 px-5 py-4 md:px-6">
          {footer}
        </div>
      )}
    </section>
  )
}

export function PromptSectionOrdinal({
  index,
  included,
  className,
}: {
  index: number
  included: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'mono inline-flex h-9 w-10 shrink-0 items-center justify-center border text-[11px] tabular-nums',
        included
          ? 'border-[color:var(--prompt-zone-border)] bg-[color:var(--prompt-zone-soft)] text-[color:var(--prompt-zone-color)]'
          : 'border-border/70 bg-secondary/40 text-muted',
        className
      )}
    >
      {String(index).padStart(2, '0')}
    </span>
  )
}
