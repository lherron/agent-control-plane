import { PageHeader } from '@/components/page-header'
import { ErrorBanner, FieldRow, PageLoading, Pill, StatusDot } from '@/components/primitives'
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

function fmtTick(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s === Math.floor(s) ? `${s}s` : `${s.toFixed(1)}s`
}

export function SchedulerStatePage() {
  const query = useQuery({
    queryKey: ['scheduler-state'],
    queryFn: fetchSchedulerState,
    refetchInterval: 5_000,
  })

  if (query.isLoading) return <PageLoading label="Loading" />
  if (query.error instanceof Error) return <ErrorBanner message={query.error.message} />
  if (!query.data) return <ErrorBanner message="Scheduler state unavailable." />
  const state = query.data

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Scheduler"
        right={
          <Pill tone={state.enabled ? 'success' : 'destructive'}>
            <StatusDot tone={state.enabled ? 'success' : 'destructive'} pulse={state.enabled} />
            {state.enabled ? 'running' : 'halted'}
          </Pill>
        }
      />

      <div className="flex-1 px-10 py-12 rise rise-2 max-w-3xl">
        <dl>
          <FieldRow label="Tick interval">
            <span className="mono text-[16px] tabular">{fmtTick(state.tickIntervalMs)}</span>
          </FieldRow>
          <FieldRow label="Due">
            <span className="mono text-[16px] tabular">{state.dueCount}</span>
          </FieldRow>
          <FieldRow label="Claimed">
            <span className="mono text-[16px] tabular">{state.claimedCount}</span>
          </FieldRow>
          <FieldRow label="Errors">
            {state.errors.length === 0 ? (
              <span className="text-muted">None.</span>
            ) : (
              <pre className="mono text-[11px] leading-relaxed text-destructive overflow-auto max-h-72 whitespace-pre-wrap">
                {JSON.stringify(state.errors, null, 2)}
              </pre>
            )}
          </FieldRow>
          {state.note && (
            <FieldRow label="Note">
              <span className="text-muted">{state.note}</span>
            </FieldRow>
          )}
        </dl>
      </div>
    </div>
  )
}
