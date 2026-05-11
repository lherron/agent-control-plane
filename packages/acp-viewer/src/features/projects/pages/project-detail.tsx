import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, FolderKanban } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ProjectAgentsTab } from '../components/project-agents-tab'
import { ProjectInterfacesTab } from '../components/project-interfaces-tab'
import { ProjectJobsTab } from '../components/project-jobs-tab'
import { ProjectOverviewTab } from '../components/project-overview-tab'
import { ProjectRawTab } from '../components/project-raw-tab'
import { ProjectSystemEventsTab } from '../components/project-system-events-tab'
import { fetchProjectDetail } from '../data'
import type { ProjectDetailState } from '../types'

const tabs = ['Overview', 'Agents', 'Jobs', 'Interfaces', 'System Events', 'Raw'] as const
type ProjectTab = (typeof tabs)[number]

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const [activeTab, setActiveTab] = useState<ProjectTab>('Overview')
  const query = useQuery({
    queryKey: ['projects', projectId, 'detail'],
    queryFn: () => fetchProjectDetail(projectId ?? ''),
    enabled: projectId !== undefined && projectId.length > 0,
  })

  if (projectId === undefined) {
    return <div className="p-6 text-destructive">Missing project id.</div>
  }

  if (query.isLoading) {
    return <div className="p-6 text-muted">Loading project...</div>
  }

  if (query.error instanceof Error) {
    return <div className="p-6 text-destructive">{query.error.message}</div>
  }

  if (query.data === undefined) {
    return <div className="p-6 text-muted">Project not found.</div>
  }

  const detail = query.data

  return (
    <div className="p-6 space-y-5">
      <Link to="/projects" className="inline-flex items-center gap-2 text-sm text-muted hover:text-accent">
        <ArrowLeft className="h-4 w-4" />
        Projects
      </Link>

      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-selected text-selected-foreground">
          <FolderKanban className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{detail.project.displayName}</h1>
          <p className="font-mono text-xs text-muted">{detail.project.projectId}</p>
        </div>
      </header>

      <Tabs>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} active={activeTab === tab} onClick={() => setActiveTab(tab)}>
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent>
          {activeTab === 'Overview' ? <ProjectOverviewTab detail={detail} /> : null}
          {activeTab === 'Agents' ? <ProjectAgentsTab detail={detail} /> : null}
          {activeTab === 'Jobs' ? <ProjectJobsTab detail={detail} /> : null}
          {activeTab === 'Interfaces' ? <ProjectInterfacesTab detail={detail} /> : null}
          {activeTab === 'System Events' ? <ProjectSystemEventsTab detail={detail} /> : null}
          {activeTab === 'Raw' ? <ProjectRawTab detail={detail} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}
