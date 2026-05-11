import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listJobs } from '@/lib/api'
import type { JobKind, JobRecord } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type StatusFilter = 'all' | 'enabled' | 'disabled'

function inferKind(job: JobRecord): JobKind {
  if (job.flow !== undefined) return 'flow'
  if (Array.isArray(job.input['argv']) || typeof job.input['command'] === 'string') return 'exec'
  return 'input'
}

function groupByProjectAgent(jobs: JobRecord[]): Map<string, JobRecord[]> {
  const groups = new Map<string, JobRecord[]>()
  for (const job of jobs) {
    const key = `${job.projectId} / ${job.agentId}`
    const list = groups.get(key) ?? []
    list.push(job)
    groups.set(key, list)
  }
  return groups
}

export function JobsCatalog() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const navigate = useNavigate()

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
          j.projectId.toLowerCase().includes(q) ||
          j.agentId.toLowerCase().includes(q)
      )
    }

    if (statusFilter === 'enabled') {
      result = result.filter((j) => !j.disabled)
    } else if (statusFilter === 'disabled') {
      result = result.filter((j) => j.disabled)
    }

    return result
  }, [jobs, search, statusFilter])

  const grouped = useMemo(() => groupByProjectAgent(filtered), [filtered])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading jobs...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive text-sm">
        Error loading jobs: {String(error)}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        <Input
          placeholder="Search job, project, or agent..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs text-xs h-8"
        />
        <div className="flex gap-1">
          {(['all', 'enabled', 'disabled'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                statusFilter === f
                  ? 'bg-selected text-selected-foreground font-medium'
                  : 'text-muted hover:bg-secondary'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="text-xs text-quiet ml-auto">
          {filtered.length} job{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {Array.from(grouped.entries()).map(([groupKey, groupJobs]) => (
          <div key={groupKey}>
            <div className="sticky top-0 bg-workbench px-4 py-1.5 text-xs font-semibold text-muted border-b border-border">
              {groupKey}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">State</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="w-16">Kind</TableHead>
                  <TableHead>Next Fire</TableHead>
                  <TableHead>Last Fire</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groupJobs.map((job) => (
                  <TableRow
                    key={job.jobId}
                    className="cursor-pointer"
                    onClick={() => navigate(`/jobs/${encodeURIComponent(job.jobId)}`)}
                  >
                    <TableCell>
                      <Badge
                        variant={job.disabled ? 'destructive' : 'secondary'}
                        className="text-[10px]"
                      >
                        {job.disabled ? 'off' : 'on'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs text-foreground">{job.jobId}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.schedule.cron}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {inferKind(job)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {job.nextFireAt ? new Date(job.nextFireAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {job.lastFireAt ? new Date(job.lastFireAt).toLocaleString() : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

        {grouped.size === 0 && (
          <div className="flex items-center justify-center py-12 text-quiet text-sm">
            {search || statusFilter !== 'all'
              ? 'No jobs match the current filters.'
              : 'No jobs found.'}
          </div>
        )}
      </div>
    </div>
  )
}
