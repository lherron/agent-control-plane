import type { DashboardEvent } from '@/features/sessions/types'
import { cn } from '@/lib/cn'
import { ShieldAlert } from 'lucide-react'
import {
  clockLabel,
  compactRef,
  FAMILY_ACCENT,
  FAMILY_TEXT,
  payloadPreview,
  severityTone,
} from './event-family'

export function EventInspector({ event }: { event: DashboardEvent | undefined }) {
  return (
    <aside className="flex min-h-[320px] flex-col bg-paper/60 xl:min-h-0 xl:w-[390px] xl:border-l xl:border-border">
      <header className="border-b border-border px-4 py-3">
        <h2 className="display text-[22px] leading-none text-ink">Event detail</h2>
        <p className="mt-1 text-[12px] text-muted">Details only</p>
      </header>

      {!event ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-xs">
            <div className="mx-auto h-px w-20 bg-accent" />
            <h3 className="display mt-5 text-[28px] leading-none text-ink">Select an event</h3>
            <p className="mt-3 text-[13px] leading-6 text-muted">
              Choose a stream row to inspect its hrc envelope, session reference, severity, and
              payload preview.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 py-4">
          <div className="mb-4 rounded-[6px] border border-border bg-card/70 p-4">
            <div className="flex items-start gap-3">
              <span className={cn('mt-1 h-2.5 w-2.5 rounded-full', FAMILY_ACCENT[event.family])} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold leading-5 text-ink">
                  {event.label || event.eventKind}
                </h3>
                <p className="mt-1 text-[12px] leading-5 text-muted">{payloadPreview(event)}</p>
              </div>
            </div>
            {event.redacted && (
              <div className="mt-3 flex items-center gap-2 rounded-[4px] border border-warn/40 bg-warn-soft px-2.5 py-2 text-[12px] text-warn">
                <ShieldAlert className="h-3.5 w-3.5" />
                Payload preview was redacted before rendering.
              </div>
            )}
          </div>

          <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[12px]">
            <Field label="eventKind" value={event.eventKind} />
            <Field label="family" value={event.family} valueClassName={FAMILY_TEXT[event.family]} />
            <Field label="severity" value={event.severity} valueClassName={severityTone(event.severity)} />
            <Field label="ts" value={`${event.ts} (${clockLabel(event.ts)})`} />
            <Field label="hrcSeq" value={String(event.hrcSeq)} />
            {event.streamSeq !== undefined && <Field label="streamSeq" value={String(event.streamSeq)} />}
            {event.category && <Field label="category" value={event.category} />}
            <Field label="scopeRef" value={event.sessionRef.scopeRef} />
            <Field label="laneRef" value={event.sessionRef.laneRef} />
            <Field label="hostSessionId" value={event.hostSessionId} />
            <Field label="generation" value={String(event.generation)} />
            {event.runtimeId && <Field label="runtimeId" value={event.runtimeId} />}
            {event.runId && <Field label="runId" value={event.runId} />}
            {event.launchId && <Field label="launchId" value={event.launchId} />}
          </dl>

          <div className="mt-5">
            <div className="kicker mb-2 text-muted">payloadPreview</div>
            <pre className="max-h-[360px] overflow-auto rounded-[6px] border border-border bg-background/70 p-3 mono text-[11px] leading-5 text-ink">
              {JSON.stringify(event.payloadPreview ?? {}, null, 2)}
            </pre>
          </div>

          <div className="mt-4 text-[11px] text-quiet">
            {compactRef(event.id, 64)}
          </div>
        </div>
      )}
    </aside>
  )
}

function Field({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string | undefined
}) {
  return (
    <>
      <dt className="kicker text-[9px] text-muted">{label}</dt>
      <dd className={cn('min-w-0 break-words mono text-[11px] tabular text-ink', valueClassName)}>
        {value}
      </dd>
    </>
  )
}

