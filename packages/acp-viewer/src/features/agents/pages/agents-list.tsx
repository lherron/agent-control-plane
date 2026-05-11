import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AgentSummary } from '@/types/api'
import { useQuery } from '@tanstack/react-query'
import {
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Bot } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { heartbeatStatus } from '../agent-utils'
import { fetchAgentDetail, fetchAgents } from '../data'

interface AgentRow extends AgentSummary {
  membershipsCount: number | undefined
  defaultProjectCount: number | undefined
  assignedJobsCount: number | undefined
  heartbeat: string
}

const columnHelper = createColumnHelper<AgentRow>()

// Single batched fetch instead of useQueries dynamic-length pattern
// (see ProjectsListPage bugfix notes for why).
async function fetchAgentsWithRollups(): Promise<AgentRow[]> {
  const agents = await fetchAgents()
  const details = await Promise.all(
    agents.map((a) => fetchAgentDetail(a.agentId).catch(() => undefined))
  )
  return agents.map((agent, i) => {
    const detail = details[i]
    return {
      ...agent,
      membershipsCount: detail?.memberships.length,
      defaultProjectCount: detail?.memberships.filter((m) => m.isDefaultAgent).length,
      assignedJobsCount: detail?.jobs.length,
      heartbeat: heartbeatStatus(detail?.heartbeat),
    }
  })
}

export function AgentsListPage() {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'displayName', desc: false }])
  const agentsQuery = useQuery({
    queryKey: ['agents', 'with-rollups'],
    queryFn: fetchAgentsWithRollups,
  })
  const data = useMemo<AgentRow[]>(() => agentsQuery.data ?? [], [agentsQuery.data])

  const columns = useMemo(
    () => [
      columnHelper.accessor('displayName', {
        header: 'Agent',
        cell: ({ row, getValue }) => (
          <Link
            to={`/agents/${encodeURIComponent(row.original.agentId)}`}
            className="font-medium text-primary hover:text-accent"
          >
            {getValue()}
          </Link>
        ),
      }),
      columnHelper.accessor('agentId', {
        header: 'Agent ID',
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
      }),
      columnHelper.accessor('status', {
        header: 'Status',
      }),
      columnHelper.accessor('membershipsCount', {
        header: 'Projects',
        cell: ({ getValue }) => getValue() ?? '...',
      }),
      columnHelper.accessor('defaultProjectCount', {
        header: 'Defaults',
        cell: ({ getValue }) => getValue() ?? '...',
      }),
      columnHelper.accessor('assignedJobsCount', {
        header: 'Jobs',
        cell: ({ getValue }) => getValue() ?? '...',
      }),
      columnHelper.accessor('heartbeat', {
        header: 'Heartbeat',
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

  return (
    <div className="p-6 space-y-5">
      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-selected text-selected-foreground">
          <Bot className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="text-sm text-muted">{data.length} configured agents</p>
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
            {agentsQuery.isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length}>Loading agents...</TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>No agents found.</TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
      {agentsQuery.error instanceof Error ? (
        <p className="text-sm text-destructive">{agentsQuery.error.message}</p>
      ) : null}
    </div>
  )
}
