import { PageHeader } from '@/components/page-header'
import { EmptyState, ErrorBanner, PageLoading, Pill, StatusDot } from '@/components/primitives'
import { listJobs } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { JobKind, JobRecord } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Search, Workflow } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type StatusFilter = 'all' | 'enabled' | 'disabled'

const CRON_DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

function inferKind(job: JobRecord): JobKind {
  if (job.flow !== undefined) return 'flow'
  if (Array.isArray(job.input['argv']) || typeof job.input['command'] === 'string') return 'exec'
  return 'input'
}

function kindTone(kind: JobKind): 'accent' | 'success' | 'muted' {
  if (kind === 'flow') return 'accent'
  if (kind === 'exec') return 'success'
  return 'muted'
}

function describeCron(cron: string): string {
  if (!cron) return 'manual'
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, , dow] = parts
  if (dom === '*' && dow === '*' && hour !== '*' && min !== '*') {
    const h = Number(hour)
    const m = Number(min)
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      return `Daily ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }
  if (hour === '*' && dom === '*' && dow === '*' && /^\d+$/.test(min)) {
    return `Hourly :${min.padStart(2, '0')}`
  }
  if (dom === '*' && /^\d+$/.test(dow) && hour !== '*' && min !== '*') {
    const d = CRON_DOW_LABELS[Number(dow)] ?? `dow:${dow}`
    return `${d} ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }
  return cron
}

function timeAbs(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

interface Group {
  key: string
  projectId: string
  agentId: string
  jobs: JobRecord[]
}

const GRID =
  '14px minmax(280px,1.5fr) minmax(140px,0.9fr) 70px minmax(140px,0.9fr) minmax(140px,0.9fr) 14px'

export function JobsCatalog() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [kindFilter, setKindFilter] = useState<'all' | JobKind>('all')

  const {
    data: jobs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['jobs'],
    queryFn: listJobs,
  })

  const filtered = useMemo(() => {
    if (!jobs) return []
    let result = jobs
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (j) =>
          j.jobId.toLowerCase().includes(q) ||
          j.slug.toLowerCase().includes(q) ||
          j.projectId.toLowerCase().includes(q) ||
          j.agentId.toLowerCase().includes(q) ||
          (j.description ?? '').toLowerCase().includes(q)
      )
    }
    if (statusFilter === 'enabled') result = result.filter((j) => !j.disabled)
    if (statusFilter === 'disabled') result = result.filter((j) => j.disabled)
    if (kindFilter !== 'all') result = result.filter((j) => inferKind(j) === kindFilter)
    return result
  }, [jobs, search, statusFilter, kindFilter])

  const totals = useMemo(() => {
    const base = jobs ?? []
    return {
      total: base.length,
      enabled: base.filter((j) => !j.disabled).length,
    }
  }, [jobs])

  const grouped = useMemo<Group[]>(() => {
    const map = new Map<string, Group>()
    for (const job of filtered) {
      const key = `${job.projectId}::${job.agentId}`
      let group = map.get(key)
      if (!group) {
        group = { key, projectId: job.projectId, agentId: job.agentId, jobs: [] }
        map.set(key, group)
      }
      group.jobs.push(job)
    }
    return Array.from(map.values()).sort((a, b) =>
      a.projectId === b.projectId
        ? a.agentId.localeCompare(b.agentId)
        : a.projectId.localeCompare(b.projectId)
    )
  }, [filtered])

  if (isLoading) return <PageLoading label="Loading" />
  if (error) return <ErrorBanner message={String(error)} />

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Jobs"
        meta={[
          { label: 'Total', value: totals.total },
          { label: 'Enabled', value: totals.enabled },
        ]}
      />

      {/* Filter rail */}
      <div className="px-10 py-3 flex items-center gap-6 border-b border-border/60 rise rise-2">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search className="h-3.5 w-3.5 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            className="flex-1 bg-transparent text-[13px] placeholder:text-quiet focus:outline-none"
          />
        </div>

        <Segment
          value={statusFilter}
          options={[
            { v: 'all', l: 'All' },
            { v: 'enabled', l: 'Enabled' },
            { v: 'disabled', l: 'Disabled' },
          ]}
          onChange={(v) => setStatusFilter(v)}
        />

        <Segment
          value={kindFilter}
          options={[
            { v: 'all', l: 'All kinds' },
            { v: 'flow', l: 'Flow' },
            { v: 'input', l: 'Input' },
            { v: 'exec', l: 'Exec' },
          ]}
          onChange={(v) => setKindFilter(v)}
        />

        <span className="mono text-[10px] text-muted tabular ml-auto">
          {filtered.length} of {totals.total}
        </span>
      </div>

      {/* Listing */}
      <div className="flex-1 px-10 py-8 rise rise-3">
        {grouped.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-8 w-8" />}
            title="Nothing matches"
            description="Try clearing search or relaxing the filters."
          />
        ) : (
          <div className="space-y-12">
            {/* Single column header for entire listing */}
            <div
              style={{ gridTemplateColumns: GRID }}
              className="grid items-center gap-x-6 pb-2 border-b border-border/60"
            >
              {[null, 'Job', 'Schedule', 'Kind', 'Next fire', 'Last fire', null].map((label, i) => (
                <span key={label ?? `_${i}`} className="kicker text-muted truncate">
                  {label ?? ''}
                </span>
              ))}
            </div>

            {grouped.map((group) => (
              <section key={group.key} className="space-y-2">
                <header className="flex items-baseline gap-3 pb-1">
                  <h3 className="display text-[18px] text-ink leading-none">{group.projectId}</h3>
                  <span className="text-quiet">·</span>
                  <span className="mono text-[12px] text-muted">{group.agentId}</span>
                </header>

                <ul>
                  {group.jobs.map((job) => {
                    const kind = inferKind(job)
                    return (
                      <li key={job.jobId}>
                        <Link
                          to={`/jobs/${encodeURIComponent(job.jobId)}`}
                          style={{ gridTemplateColumns: GRID }}
                          className="grid items-center gap-x-6 group py-3 border-b border-border/40 transition-colors hover:bg-paper/40"
                        >
                          <StatusDot
                            tone={job.disabled ? 'destructive' : 'success'}
                            pulse={!job.disabled}
                          />
                          <div className="min-w-0">
                            <div className="text-[14px] text-ink font-medium truncate">
                              {job.slug}
                            </div>
                            {job.description && (
                              <div className="text-[12px] text-muted truncate mt-0.5">
                                {job.description}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-[12px] text-ink tabular truncate">
                              {describeCron(job.schedule.cron)}
                            </span>
                            <span className="mono text-[10px] text-quiet tabular">
                              {job.schedule.cron}
                            </span>
                          </div>
                          <Pill tone={kindTone(kind)}>{kind}</Pill>
                          <span className="mono text-[12px] tabular text-ink truncate">
                            {timeAbs(job.nextFireAt)}
                          </span>
                          <span className="mono text-[12px] tabular text-muted truncate">
                            {timeAbs(job.lastFireAt)}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5 text-quiet/0 group-hover:text-accent transition-all" />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<{ v: T; l: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center text-[11px]">
      {options.map((opt, i) => (
        <button
          key={opt.v}
          type="button"
          onClick={() => onChange(opt.v)}
          className={cn(
            'px-2.5 py-1 transition-colors',
            value === opt.v ? 'text-ink font-medium' : 'text-muted hover:text-ink',
            i > 0 &&
              'before:content-[""] before:inline-block before:w-px before:h-3 before:bg-border before:mr-2.5 before:align-middle'
          )}
        >
          {opt.l}
        </button>
      ))}
    </div>
  )
}
