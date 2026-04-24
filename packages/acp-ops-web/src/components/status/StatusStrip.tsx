import type { DashboardEventFamily, SessionDashboardSummary } from 'acp-ops-projection'
import { FAMILY_COLORS } from '../../lib/colors'

function Sparkline({ tone = 'runtime' }: { tone?: DashboardEventFamily }) {
  const color = FAMILY_COLORS[tone] ?? FAMILY_COLORS.runtime
  return (
    <svg className="mini-sparkline" viewBox="0 0 118 28" aria-hidden="true">
      <path
        d="M2 20 C8 19 12 21 17 19 S26 13 31 18 39 24 45 18 51 7 57 16 64 22 70 16 76 10 83 15 89 20 96 15 103 8 116 10"
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}

function TinyMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: DashboardEventFamily
}) {
  return (
    <div className={`metric-card tone-${tone}`}>
      <span className="metric-glyph" aria-hidden="true" />
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <Sparkline tone={tone} />
    </div>
  )
}

export function StatusStrip({ summary }: { summary: SessionDashboardSummary }) {
  return (
    <section className="status-strip" data-testid="status-strip" aria-label="status strip">
      <TinyMetric label="Busy" value={summary.counts.busy} tone="runtime" />
      <TinyMetric label="Idle" value={summary.counts.idle} tone="runtime" />
      <TinyMetric label="Launching" value={summary.counts.launching} tone="tool" />
      <TinyMetric label="Stale" value={summary.counts.stale + summary.counts.dead} tone="warning" />
      <TinyMetric label="In-flight inputs" value={summary.counts.inFlightInputs} tone="input" />
      <TinyMetric label="Stream lag" value={`${summary.streamLagMs ?? 0}ms`} tone="delivery" />
    </section>
  )
}
