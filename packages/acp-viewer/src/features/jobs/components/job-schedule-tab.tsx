import { Badge } from '@/components/ui/badge'
import type { JobDetailResponse } from '@/types/api'

interface JobScheduleTabProps {
  data: JobDetailResponse
}

export function JobScheduleTab({ data }: JobScheduleTabProps) {
  const { schedule, job } = data

  return (
    <div className="space-y-4 p-4 text-xs">
      <div className="flex gap-2">
        <span className="text-muted w-28 shrink-0">Cron</span>
        <span className="font-mono text-foreground">{schedule.cron}</span>
      </div>

      <div className="flex gap-2">
        <span className="text-muted w-28 shrink-0">State</span>
        <Badge variant={job.disabled ? 'destructive' : 'secondary'} className="text-[10px]">
          {job.disabled ? 'disabled' : 'enabled'}
        </Badge>
      </div>

      {schedule.nextFireAt && (
        <div className="flex gap-2">
          <span className="text-muted w-28 shrink-0">Next Fire</span>
          <span className="text-foreground">{new Date(schedule.nextFireAt).toLocaleString()}</span>
        </div>
      )}

      {schedule.lastFireAt && (
        <div className="flex gap-2">
          <span className="text-muted w-28 shrink-0">Last Fire</span>
          <span className="text-foreground">{new Date(schedule.lastFireAt).toLocaleString()}</span>
        </div>
      )}

      {schedule.windowStart && (
        <div className="flex gap-2">
          <span className="text-muted w-28 shrink-0">Window Start</span>
          <span className="text-foreground">{schedule.windowStart}</span>
        </div>
      )}

      {schedule.windowEnd && (
        <div className="flex gap-2">
          <span className="text-muted w-28 shrink-0">Window End</span>
          <span className="text-foreground">{schedule.windowEnd}</span>
        </div>
      )}

      {typeof schedule.windowMinutes === 'number' && (
        <div className="flex gap-2">
          <span className="text-muted w-28 shrink-0">Window Minutes</span>
          <span className="text-foreground">{schedule.windowMinutes}</span>
        </div>
      )}

      {schedule.nextFirePreview && schedule.nextFirePreview.length > 0 && (
        <div>
          <div className="text-muted mb-2">Upcoming Fires</div>
          <div className="space-y-1">
            {schedule.nextFirePreview.map((fire, i) => (
              <div key={fire} className="flex gap-2 items-center">
                <span className="text-quiet w-6 text-right">{i + 1}.</span>
                <span className="font-mono text-foreground">{new Date(fire).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
