import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: ReactNode
  /** Optional italic display-serif emphasis appended to the title. Use sparingly. */
  emphasis?: string
  /** Optional one-line context above the title. */
  eyebrow?: ReactNode
  meta?: Array<{ label: string; value: ReactNode }>
  right?: ReactNode
  className?: string
}

export function PageHeader({ title, emphasis, eyebrow, meta, right, className }: PageHeaderProps) {
  return (
    <header className={cn('relative px-10 pt-12 pb-8', className)}>
      <div className="flex items-end justify-between gap-8">
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="kicker text-muted mb-3">{eyebrow}</div>}
          <h1 className="display text-[64px] text-ink leading-[0.92] tracking-[-0.025em]">
            {title}
            {emphasis && (
              <>
                {' '}
                <span className="display-italic text-accent">{emphasis}</span>
              </>
            )}
          </h1>
        </div>
        {right && <div className="shrink-0 pb-2">{right}</div>}
      </div>

      {meta && meta.length > 0 && (
        <dl className="mt-8 flex flex-wrap gap-x-12 gap-y-3">
          {meta.map((item) => (
            <div key={item.label} className="flex flex-col">
              <dt className="kicker text-muted">{item.label}</dt>
              <dd className="mt-1 mono text-[12px] tabular text-ink">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  )
}
