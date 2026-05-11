import { EmptyState, Pill } from '@/components/primitives'
import { Target } from 'lucide-react'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

const GRID = 'minmax(280px,2fr) 120px 110px'

export function AgentScopeTargetsTab({ detail }: Props) {
  if (detail.scopeTargets.length === 0) {
    return <EmptyState icon={<Target className="h-8 w-8" />} title="No targets" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {['Scope', 'Lane', 'Source'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label}
          </span>
        ))}
      </div>

      <ul>
        {detail.scopeTargets.map((t) => (
          <li
            key={`${t.scopeRef}:${t.laneRef}:${t.source}`}
            style={{ gridTemplateColumns: GRID }}
            className="grid items-center gap-x-6 py-3 border-b border-border/40"
          >
            <span className="mono text-[11.5px] text-ink truncate">{t.scopeRef}</span>
            <span className="mono text-[11.5px] text-ink">{t.laneRef}</span>
            <Pill tone={t.source === 'membership' ? 'muted' : 'accent'}>{t.source}</Pill>
          </li>
        ))}
      </ul>
    </section>
  )
}
