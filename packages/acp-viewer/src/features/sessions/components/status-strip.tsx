import type { ReactNode } from 'react'
import type { SessionDashboardSummary } from '@/features/sessions/types'
import { Activity, CircleDot, Clock3, Hourglass, MailWarning, RadioTower, Zap } from 'lucide-react'

const metricDefs = [
  { key: 'busy', label: 'Busy', icon: Zap },
  { key: 'idle', label: 'Idle', icon: CircleDot },
  { key: 'launching', label: 'Launching', icon: RadioTower },
  { key: 'staleDead', label: 'Stale/dead', icon: Clock3 },
  { key: 'inFlightInputs', label: 'In-flight', icon: Hourglass },
  { key: 'deliveryPending', label: 'Delivery', icon: MailWarning },
] as const

export function StatusStrip({
  summary,
  controls,
}: {
  summary: SessionDashboardSummary
  controls: ReactNode
}) {
  const values: Record<(typeof metricDefs)[number]['key'], number> = {
    busy: summary.counts.busy,
    idle: summary.counts.idle,
    launching: summary.counts.launching,
    staleDead: summary.counts.stale + summary.counts.dead,
    inFlightInputs: summary.counts.inFlightInputs,
    deliveryPending: summary.counts.deliveryPending,
  }

  return (
    <section className="border-b border-border bg-paper/70 px-5 py-4 md:px-8">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 xl:flex xl:flex-wrap">
          {metricDefs.map((metric) => {
            const Icon = metric.icon
            return (
              <div
                key={metric.key}
                className="min-w-[118px] rounded-[6px] border border-border bg-card/60 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="kicker text-[9px] text-muted">{metric.label}</span>
                  <Icon className="h-3.5 w-3.5 text-accent" />
                </div>
                <strong className="mono mt-1 block text-[20px] leading-none tabular text-ink">
                  {values[metric.key].toLocaleString()}
                </strong>
              </div>
            )
          })}
          <div className="min-w-[140px] rounded-[6px] border border-accent/35 bg-accent/10 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="kicker text-[9px] text-accent">Events/min</span>
              <Activity className="h-3.5 w-3.5 text-accent" />
            </div>
            <strong className="mono mt-1 block text-[20px] leading-none tabular text-accent-warm">
              {summary.eventRatePerMinute.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </strong>
          </div>
        </div>
        {controls}
      </div>
    </section>
  )
}

