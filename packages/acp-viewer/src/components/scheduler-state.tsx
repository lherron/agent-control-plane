import { fetchJson } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'

interface SchedulerStateResponse {
  enabled: boolean
  tickIntervalMs: number
  dueCount: number
  claimedCount: number
  errors: unknown[]
  note?: string | undefined
}

async function fetchSchedulerState(): Promise<SchedulerStateResponse> {
  return fetchJson<SchedulerStateResponse>('/v1/admin/jobs/scheduler')
}

export function SchedulerStatePanel() {
  const query = useQuery({
    queryKey: ['scheduler-state'],
    queryFn: fetchSchedulerState,
    refetchInterval: 5_000,
  })

  if (query.isLoading) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-sm text-muted">
        Loading scheduler state...
      </div>
    )
  }

  if (query.error instanceof Error) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-sm text-destructive">
        {query.error.message}
      </div>
    )
  }

  const state = query.data
  if (state === undefined) {
    return (
      <div className="rounded-md border border-border bg-card p-4 text-sm text-muted">
        Scheduler state unavailable.
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-card p-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Enabled" value={state.enabled ? 'Yes' : 'No'} />
        <Field label="Tick interval" value={`${state.tickIntervalMs} ms`} />
        <Field label="Due jobs" value={String(state.dueCount)} />
        <Field label="Claimed jobs" value={String(state.claimedCount)} />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="font-medium">Errors</div>
        {state.errors.length === 0 ? (
          <div className="mt-1 text-muted">None</div>
        ) : (
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs">
            {JSON.stringify(state.errors, null, 2)}
          </pre>
        )}
      </div>

      {state.note !== undefined ? (
        <div className="mt-4 border-t border-border pt-4 text-muted">{state.note}</div>
      ) : null}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  )
}
