import type { ReactNode } from 'react'
import { clockLabel } from '../lib/time'

export function DashboardShell({
  highContrast,
  serverTime,
  status,
  queue,
  timeline,
  inspector,
  controls,
}: {
  highContrast: boolean
  serverTime?: string | undefined
  status: ReactNode
  queue: ReactNode
  timeline: ReactNode
  inspector: ReactNode
  controls: ReactNode
}) {
  return (
    <main
      className={highContrast ? 'dashboard-shell high-contrast' : 'dashboard-shell'}
      aria-label="ACP session dashboard"
    >
      <header className="app-header">
        <div className="brand-lockup">
          <strong>
            <span>⌁</span> ACP/HRC
          </strong>
          <em>Live Ops</em>
        </div>
        <span className="header-divider" />
        <h1>In-Flight Sessions</h1>
        <div className="header-ops">
          <span>UTC&nbsp; {clockLabel(serverTime)}</span>
          <span className="live-indicator">Live</span>
          <label className="auto-refresh">
            Auto-refresh
            <select defaultValue="on" aria-label="auto-refresh">
              <option value="on">ON</option>
              <option value="off">OFF</option>
            </select>
          </label>
          <button type="button">▷ Replay</button>
          <button type="button" aria-label="display settings">
            ☷
          </button>
          <button type="button" aria-label="confirm view">
            ✓
          </button>
        </div>
      </header>

      <nav className="side-nav" aria-label="dashboard navigation">
        {['Overview', 'Sessions', 'Events', 'Runs', 'Tools', 'Handoffs', 'Alerts', 'Settings'].map(
          (item) => (
            <button
              key={item}
              type="button"
              className={item === 'Sessions' ? 'active' : undefined}
              aria-current={item === 'Sessions' ? 'page' : undefined}
            >
              <span aria-hidden="true" />
              {item}
              {item === 'Alerts' && <em>3</em>}
            </button>
          )
        )}
        <button type="button" className="collapse-nav" aria-label="collapse navigation">
          »
        </button>
      </nav>

      {status}
      {queue}
      {timeline}
      {inspector}
      {controls}
    </main>
  )
}
