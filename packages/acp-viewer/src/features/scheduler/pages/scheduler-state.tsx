import { SchedulerStatePanel } from '@/components/scheduler-state'
import { Clock } from 'lucide-react'

export function SchedulerStatePage() {
  return (
    <div className="p-6 space-y-5">
      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-selected text-selected-foreground">
          <Clock className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Scheduler</h1>
          <p className="text-sm text-muted">Durable scheduler state</p>
        </div>
      </header>
      <div className="max-w-3xl">
        <SchedulerStatePanel />
      </div>
    </div>
  )
}
