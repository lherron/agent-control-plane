import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ProjectSummary } from '@/types/api'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { FolderKanban } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProjectDetail, fetchProjects } from '../data'
import { formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface ProjectRow extends ProjectSummary {
  jobCount: number | undefined
}

const columnHelper = createColumnHelper<ProjectRow>()

export function ProjectsListPage() {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'defaultAgentId', desc: false },
    { id: 'displayName', desc: false },
  ])
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  })
  const projects = projectsQuery.data ?? []
  const detailQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ['projects', project.projectId, 'detail'],
      queryFn: () => fetchProjectDetail(project.projectId),
      staleTime: 30_000,
    })),
  })

  const detailByProjectId = useMemo(() => {
    return new Map(
      detailQueries
        .map((query, index) => [projects[index]?.projectId, query.data] as const)
        .filter((entry): entry is readonly [string, ProjectDetailState] => entry[0] !== undefined)
    )
  }, [detailQueries, projects])

  const data = useMemo<ProjectRow[]>(
    () =>
      projects.map((project) => ({
        ...project,
        jobCount: detailByProjectId.get(project.projectId)?.jobs.length,
      })),
    [detailByProjectId, projects]
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor('displayName', {
        header: 'Project',
        cell: ({ row, getValue }) => (
          <Link
            to={`/projects/${encodeURIComponent(row.original.projectId)}`}
            className="font-medium text-primary hover:text-accent"
          >
            {getValue()}
          </Link>
        ),
      }),
      columnHelper.accessor('projectId', {
        header: 'Project ID',
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
      }),
      columnHelper.accessor('defaultAgentId', {
        header: 'Default Agent',
        cell: ({ getValue }) => getValue() ?? 'None',
      }),
      columnHelper.accessor('rootDir', {
        header: 'Root Dir',
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() ?? 'None'}</span>,
      }),
      columnHelper.accessor('jobCount', {
        header: 'Jobs',
        cell: ({ getValue }) => getValue() ?? '...',
      }),
      columnHelper.accessor('updatedAt', {
        header: 'Updated',
        cell: ({ getValue }) => formatDateTime(getValue()),
      }),
    ],
    []
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const rows = table.getRowModel().rows
  let currentDefaultAgent = ''

  return (
    <div className="p-6 space-y-5">
      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-selected text-selected-foreground">
          <FolderKanban className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted">{data.length} configured projects</p>
        </div>
      </header>

      <section className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {projectsQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length}>Loading projects...</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>No projects found.</TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const defaultAgent = row.original.defaultAgentId ?? 'No default agent'
                const showGroup = defaultAgent !== currentDefaultAgent
                currentDefaultAgent = defaultAgent

                return (
                  <Fragment key={row.id}>
                    {showGroup ? (
                      <TableRow key={`${defaultAgent}-group`} className="bg-secondary/60">
                        <TableCell colSpan={columns.length} className="text-xs uppercase text-muted">
                          Default agent: {defaultAgent}
                        </TableCell>
                      </TableRow>
                    ) : null}
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  </Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </section>
      {projectsQuery.error instanceof Error ? (
        <p className="text-sm text-destructive">{projectsQuery.error.message}</p>
      ) : null}
    </div>
  )
}
