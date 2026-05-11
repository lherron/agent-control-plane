import { EmptyState, FieldRow, Pill, SectionHeader, StatusDot } from '@/components/primitives'
import { Heart } from 'lucide-react'
import { formatDateTime } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
  loading: boolean
}

function tone(status: string): 'success' | 'warn' | 'destructive' | 'muted' {
  if (status === 'alive') return 'success'
  if (status === 'stale') return 'warn'
  if (status === 'dead' || status === 'down') return 'destructive'
  return 'muted'
}

export function AgentHeartbeatTab({ detail, loading }: Props) {
  const heartbeat = detail.heartbeat

  if (loading && heartbeat === undefined) {
    return <div className="text-[12px] text-muted">Loading…</div>
  }

  if (heartbeat === undefined || heartbeat === null) {
    return <EmptyState icon={<Heart className="h-8 w-8" />} title="No heartbeat" />
  }

  const t = tone(heartbeat.status)

  return (
    <section className="grid grid-cols-1 xl:grid-cols-[1fr_2fr] gap-x-16 gap-y-12 max-w-5xl">
      <div>
        <div className="flex flex-col items-start gap-4">
          <StatusDot tone={t} pulse={heartbeat.status === 'alive'} className="h-3 w-3" />
          <div className="display text-[56px] text-ink tracking-tight leading-none">
            {heartbeat.status}
          </div>
          <Pill tone={t}>since {formatDateTime(heartbeat.lastHeartbeatAt)}</Pill>
        </div>
      </div>

      <div>
        <SectionHeader title="Detail" />
        <dl>
          <FieldRow label="Last seen">{formatDateTime(heartbeat.lastHeartbeatAt)}</FieldRow>
          <FieldRow label="Source">{heartbeat.source ?? '—'}</FieldRow>
          <FieldRow label="Note">{heartbeat.lastNote ?? '—'}</FieldRow>
          <FieldRow label="Target scope">
            <span className="mono">{heartbeat.targetScopeRef ?? '—'}</span>
          </FieldRow>
          <FieldRow label="Target lane">{heartbeat.targetLaneRef ?? '—'}</FieldRow>
        </dl>
      </div>
    </section>
  )
}
