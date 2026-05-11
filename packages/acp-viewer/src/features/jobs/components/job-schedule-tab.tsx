import { FieldRow, Pill, SectionHeader } from '@/components/primitives'
import type { JobDetailResponse } from '@/types/api'

interface JobScheduleTabProps {
  data: JobDetailResponse
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}

export function JobScheduleTab({ data }: JobScheduleTabProps) {
  const { schedule, job } = data
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_1fr] gap-x-16 gap-y-12 max-w-5xl">
      <section>
        <SectionHeader title="Cron" />
        <dl>
          <FieldRow label="Expression">
            <span className="mono text-[16px] tabular">{schedule.cron}</span>
          </FieldRow>
          <FieldRow label="State">
            <Pill tone={job.disabled ? 'destructive' : 'success'}>
              {job.disabled ? 'disabled' : 'enabled'}
            </Pill>
          </FieldRow>
          {schedule.windowStart && <FieldRow label="Window start">{schedule.windowStart}</FieldRow>}
          {schedule.windowEnd && <FieldRow label="Window end">{schedule.windowEnd}</FieldRow>}
          {typeof schedule.windowMinutes === 'number' && (
            <FieldRow label="Window minutes">{schedule.windowMinutes}</FieldRow>
          )}
        </dl>
      </section>

      <section>
        <SectionHeader title="Fires" />
        <dl>
          <FieldRow label="Last">{fmtDate(schedule.lastFireAt)}</FieldRow>
          <FieldRow label="Next">{fmtDate(schedule.nextFireAt)}</FieldRow>
        </dl>

        {schedule.nextFirePreview && schedule.nextFirePreview.length > 0 && (
          <ol className="mt-8 space-y-1">
            <div className="kicker text-muted mb-2">Upcoming</div>
            {schedule.nextFirePreview.map((fire) => (
              <li key={fire} className="mono text-[12px] tabular text-ink py-0.5">
                {fmtDate(fire)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
