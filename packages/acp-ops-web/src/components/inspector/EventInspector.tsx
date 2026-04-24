import type { DashboardEvent } from 'acp-ops-projection'
import { compactRef } from '../../lib/sessionRefs'

export function EventInspector({ event }: { event: DashboardEvent | null }) {
  return (
    <aside className="event-inspector" data-testid="event-inspector" aria-label="event inspector">
      <div className="panel-heading">
        <h2>Event Detail</h2>
        <div className="heading-actions" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>

      <section className="event-detail-card" aria-label="selected event details">
        {!event ? (
          <p className="muted">Select an event bead or list item.</p>
        ) : (
          <>
            <header>
              <span className={`status-dot ${event.family}`} aria-hidden="true" />
              <strong>
                {compactRef(event.sessionRef.scopeRef, 34)} / {event.sessionRef.laneRef}
              </strong>
              <button type="button" aria-label="close selected event">
                ×
              </button>
            </header>
            <nav className="detail-tabs" aria-label="event detail sections">
              <span className="active">Details</span>
              <span>Input Queue</span>
              <span>Tools</span>
              <span>Fence</span>
              <span>Warnings</span>
            </nav>
            <div className="detail-body">
              <dl className="inspector-fields">
                <dt>hrcSeq</dt>
                <dd>{event.hrcSeq}</dd>
                {event.streamSeq !== undefined && (
                  <>
                    <dt>streamSeq</dt>
                    <dd>{event.streamSeq}</dd>
                  </>
                )}
                <dt>ts</dt>
                <dd>{event.ts}</dd>
                <dt>category</dt>
                <dd>{event.category ?? 'n/a'}</dd>
                <dt>eventKind</dt>
                <dd>{event.eventKind}</dd>
                <dt>scopeRef</dt>
                <dd>{event.sessionRef.scopeRef}</dd>
                <dt>laneRef</dt>
                <dd>{event.sessionRef.laneRef}</dd>
                <dt>hostSessionId</dt>
                <dd>{event.hostSessionId}</dd>
                <dt>generation</dt>
                <dd>{event.generation}</dd>
                <dt>family</dt>
                <dd>{event.family}</dd>
                <dt>severity</dt>
                <dd>{event.severity}</dd>
                {event.runId && (
                  <>
                    <dt>runId</dt>
                    <dd>{event.runId}</dd>
                  </>
                )}
                {event.runtimeId && (
                  <>
                    <dt>runtimeId</dt>
                    <dd>{event.runtimeId}</dd>
                  </>
                )}
                {event.launchId && (
                  <>
                    <dt>launchId</dt>
                    <dd>{event.launchId}</dd>
                  </>
                )}
                <dt>payloadPreview</dt>
                <dd>
                  <pre className="payload-preview">
                    {JSON.stringify(event.payloadPreview ?? {}, null, 2)}
                  </pre>
                </dd>
              </dl>
              <aside className="detail-callouts">
                <div>
                  <h3>Session Envelope</h3>
                  <p>
                    <strong>{event.hostSessionId}</strong> generation {event.generation}
                  </p>
                </div>
                <div>
                  <h3>Runtime</h3>
                  <p>
                    {event.runtimeId ?? event.runId ?? event.launchId ?? 'No runtime id on event.'}
                  </p>
                </div>
                {(event.family === 'warning' ||
                  event.severity === 'warning' ||
                  event.severity === 'error') && (
                  <div className="warning-callout">
                    <h3>{event.severity}</h3>
                    <p>{event.shortDetail ?? event.label ?? event.eventKind}</p>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </section>
    </aside>
  )
}
