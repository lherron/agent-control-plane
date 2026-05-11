import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatActor, formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectOverviewTab({ detail }: Props) {
  const project = detail.project

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="rounded-md">
        <CardHeader>
          <CardTitle>Project</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Field label="Display name" value={project.displayName} />
          <Field label="Project ID" value={project.projectId} mono />
          <Field label="Root directory" value={project.rootDir ?? 'None'} mono />
          <Field
            label="Default agent"
            value={detail.defaultAgent?.displayName ?? project.defaultAgentId ?? 'None'}
          />
        </CardContent>
      </Card>

      <Card className="rounded-md">
        <CardHeader>
          <CardTitle>Audit</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Field label="Created" value={formatDateTime(project.createdAt)} />
          <Field label="Created by" value={formatActor(project.createdBy)} />
          <Field label="Updated" value={formatDateTime(project.updatedAt)} />
          <Field label="Updated by" value={formatActor(project.updatedBy)} />
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
      <div className="text-muted">{label}</div>
      <div className={mono ? 'min-w-0 break-words font-mono text-xs' : 'min-w-0 break-words'}>
        {value}
      </div>
    </div>
  )
}
