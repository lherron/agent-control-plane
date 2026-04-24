import type {
  DashboardEvent,
  DashboardEventFamily,
  SessionDashboardSummary,
} from 'acp-ops-projection'
import { FAMILY_COLORS } from '../../lib/colors'
import { dispatchDashboardAction } from '../../store/useReducerStore'

export type ConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'replaying'
  | 'paused'
  | 'degraded'
  | 'disconnected'

export function ReplayControls({
  paused,
  highContrast,
  familyFilter,
  replayCursor,
  summary,
  lastHeartbeatAt,
  effectiveConnectionState,
  onGoLive,
  onPause,
  onHighContrastChange,
}: {
  paused: boolean
  highContrast: boolean
  familyFilter: DashboardEvent['family'] | 'all'
  replayCursor: number
  summary: SessionDashboardSummary
  lastHeartbeatAt?: string | undefined
  effectiveConnectionState: ConnectionState
  onGoLive: () => void
  onPause: () => void
  onHighContrastChange: (value: boolean) => void
}) {
  return (
    <section className="replay-controls" data-testid="replay-controls" aria-label="replay controls">
      <fieldset className="mode-buttons">
        <legend>mode</legend>
        <button type="button" className={!paused ? 'active' : ''} onClick={onGoLive}>
          Live
        </button>
        <button type="button" className={paused ? 'active' : ''} onClick={onPause}>
          Pause
        </button>
      </fieldset>
      <label>
        fromSeq
        <input inputMode="numeric" defaultValue={String(replayCursor + 1)} aria-label="fromSeq" />
      </label>
      <label>
        window
        <select defaultValue="90000" aria-label="loaded time window">
          <option value="30000">30s</option>
          <option value="90000">90s</option>
          <option value="300000">5m</option>
        </select>
      </label>
      <label>
        speed
        <select defaultValue="1" aria-label="playback speed">
          <option value="0.5">0.5x</option>
          <option value="1">1x</option>
          <option value="2">2x</option>
        </select>
      </label>
      <label>
        family
        <select
          value={familyFilter}
          aria-label="event family filter"
          onChange={(event) =>
            dispatchDashboardAction({
              type: 'filter.family',
              family: event.currentTarget.value as DashboardEventFamily | 'all',
            })
          }
        >
          <option value="all">all</option>
          {Object.keys(FAMILY_COLORS).map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={highContrast}
          onChange={(event) => onHighContrastChange(event.currentTarget.checked)}
        />
        high contrast
      </label>
      <span>dropped {summary.droppedEvents ?? 0}</span>
      <span>reconnects {summary.reconnectCount ?? 0}</span>
      <span>heartbeat {lastHeartbeatAt ?? 'none'}</span>
      <output
        className="connection-state"
        data-testid="connection-state"
        data-state={effectiveConnectionState}
      >
        {effectiveConnectionState}
      </output>
      <span className="footer-spark">
        Stream lag <strong>{summary.streamLagMs ?? 0}ms</strong>
      </span>
      <span className="footer-spark">
        Events/sec <strong>{summary.eventRatePerMinute.toLocaleString()}</strong>
      </span>
      <span className="footer-spark">
        Throughput <strong>12.4 MB/s</strong>
      </span>
    </section>
  )
}
