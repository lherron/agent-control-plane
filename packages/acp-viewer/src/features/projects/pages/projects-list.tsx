import { PageHeader } from '@/components/page-header'
import { EmptyState, ErrorBanner, PageLoading, Pill } from '@/components/primitives'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Boxes } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fetchProjectDetail, fetchProjects } from '../data'
import { formatDateTime } from '../project-utils'

interface ProjectRow {
  projectId: string
  displayName: string
  defaultAgentId: string | undefined
  rootDir: string | undefined
  updatedAt: string
  jobCount: number | undefined
  agentCount: number | undefined
}

async function fetchProjectsWithRollups(): Promise<ProjectRow[]> {
  const projects = await fetchProjects()
  const details = await Promise.all(
    projects.map((p) => fetchProjectDetail(p.projectId).catch(() => undefined))
  )
  return projects.map((project, i) => ({
    projectId: project.projectId,
    displayName: project.displayName,
    defaultAgentId: project.defaultAgentId,
    rootDir: project.rootDir,
    updatedAt: project.updatedAt,
    jobCount: details[i]?.jobs.length,
    agentCount: details[i]?.memberships.length,
  }))
}

const GRID = '14px minmax(220px,1.4fr) minmax(180px,1fr) minmax(220px,1.4fr) 60px 60px minmax(140px,0.9fr) 14px'

export function ProjectsListPage() {
  const query = useQuery({ queryKey: ['projects', 'with-rollups'], queryFn: fetchProjectsWithRollups })

  const rows = useMemo<ProjectRow[]>(
    () => (query.data ?? []).slice().sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [query.data]
  )

  if (query.isLoading) return <PageLoading label="Loading" />
  if (query.error instanceof Error) return <ErrorBanner message={query.error.message} />

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader title="Projects" meta={[{ label: 'Configured', value: rows.length }]} />

      <div className="flex-1 px-10 py-8 rise rise-2">
        {rows.length === 0 ? (
          <EmptyState icon={<Boxes className="h-8 w-8" />} title="No projects" />
        ) : (
          <>
            <div
              style={{ gridTemplateColumns: GRID }}
              className="grid items-center gap-x-6 pb-2 border-b border-border/60"
            >
              {[null, 'Project', 'ID', 'Root', 'Agents', 'Jobs', 'Updated', null].map((label, i) => (
                <span key={label ?? `_${i}`} className="kicker text-muted truncate">
                  {label ?? ''}
                </span>
              ))}
            </div>

            <ul>
              {rows.map((row) => (
                <li key={row.projectId}>
                  <Link
                    to={`/projects/${encodeURIComponent(row.projectId)}`}
                    style={{ gridTemplateColumns: GRID }}
                    className="grid items-center gap-x-6 py-3 group border-b border-border/40 transition-colors hover:bg-paper/40"
                  >
                    <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
                    <div className="text-[14px] text-ink font-medium truncate">
                      {row.displayName}
                    </div>
                    <span className="mono text-[12px] text-muted truncate">{row.projectId}</span>
                    <span className="mono text-[12px] text-ink truncate">
                      {row.rootDir || <span className="text-quiet">—</span>}
                    </span>
                    <span className="mono text-[12px] tabular text-ink">
                      {row.agentCount ?? '…'}
                    </span>
                    <span className="mono text-[12px] tabular text-ink">
                      {row.jobCount !== undefined ? (
                        row.jobCount > 0 ? (
                          <Pill tone="accent" mono>
                            {row.jobCount}
                          </Pill>
                        ) : (
                          <span className="text-quiet">0</span>
                        )
                      ) : (
                        '…'
                      )}
                    </span>
                    <span className="mono text-[11px] tabular text-muted">
                      {formatDateTime(row.updatedAt)}
                    </span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-quiet/0 group-hover:text-accent transition-all" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
