import { EmptyState, Pill } from '@/components/primitives'
import { Plug } from 'lucide-react'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

const GRID = '120px minmax(180px,1.2fr) minmax(140px,1fr) minmax(220px,1.4fr) 80px 90px'

export function ProjectInterfacesTab({ detail }: Props) {
  if (detail.interfaceBindings.length === 0) {
    return <EmptyState icon={<Plug className="h-8 w-8" />} title="No bindings" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {['Gateway', 'Conversation', 'Thread', 'Scope', 'Lane', 'Status'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label}
          </span>
        ))}
      </div>

      <ul>
        {detail.interfaceBindings.map((b) => (
          <li
            key={b.bindingId}
            style={{ gridTemplateColumns: GRID }}
            className="grid items-center gap-x-6 py-3 border-b border-border/40"
          >
            <span className="mono text-[11px] text-ink truncate">{b.gatewayId}</span>
            <span className="mono text-[11px] text-ink truncate">{b.conversationRef}</span>
            <span className="mono text-[11px] text-muted truncate">{b.threadRef ?? '—'}</span>
            <span className="mono text-[11px] text-ink truncate">{b.sessionRef.scopeRef}</span>
            <span className="mono text-[11px] text-ink truncate">{b.sessionRef.laneRef}</span>
            <Pill tone={b.status === 'active' ? 'success' : 'muted'}>{b.status}</Pill>
          </li>
        ))}
      </ul>
    </section>
  )
}
