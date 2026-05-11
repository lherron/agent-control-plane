import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectInterfacesTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Gateway</TableHead>
            <TableHead>Conversation</TableHead>
            <TableHead>Thread</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Lane</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.interfaceBindings.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>No interface bindings found.</TableCell>
            </TableRow>
          ) : (
            detail.interfaceBindings.map((binding) => (
              <TableRow key={binding.bindingId}>
                <TableCell>{binding.gatewayId}</TableCell>
                <TableCell className="font-mono text-xs">{binding.conversationRef}</TableCell>
                <TableCell className="font-mono text-xs">{binding.threadRef ?? 'None'}</TableCell>
                <TableCell className="font-mono text-xs">{binding.scopeRef ?? 'None'}</TableCell>
                <TableCell>{binding.laneRef ?? 'None'}</TableCell>
                <TableCell>{binding.status}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
