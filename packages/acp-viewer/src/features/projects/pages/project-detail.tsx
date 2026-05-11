import { PageHeader } from '@/components/page-header'
import { BackLink, ErrorBanner, PageLoading, TabBar } from '@/components/primitives'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { ProjectAgentsTab } from '../components/project-agents-tab'
import { ProjectInterfacesTab } from '../components/project-interfaces-tab'
import { ProjectJobsTab } from '../components/project-jobs-tab'
import { ProjectOverviewTab } from '../components/project-overview-tab'
import { ProjectRawTab } from '../components/project-raw-tab'
import { ProjectSystemEventsTab } from '../components/project-system-events-tab'
import { fetchProjectDetail } from '../data'

type ProjectTab = 'overview' | 'agents' | 'jobs' | 'interfaces' | 'events' | 'raw'

const TABS: ReadonlyArray<{ id: ProjectTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'events', label: 'Events' },
  { id: 'raw', label: 'Raw' },
]

export function ProjectDetailPage() {
  const { projectId } = useParams()
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview')

  const query = useQuery({
    queryKey: ['projects', projectId, 'detail'],
    queryFn: () => fetchProjectDetail(projectId ?? ''),
    enabled: projectId !== undefined && projectId.length > 0,
  })

  if (projectId === undefined) return <ErrorBanner message="Missing project id." />
  if (query.isLoading) return <PageLoading label="Loading" />
  if (query.error instanceof Error) return <ErrorBanner message={query.error.message} />
  if (query.data === undefined) return <ErrorBanner message={`Project ${projectId} not found.`} />

  const detail = query.data
  const project = detail.project

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-10 pt-8 rise rise-1">
        <BackLink to="/projects" label="Projects" />
      </div>

      <PageHeader
        title={project.displayName}
        meta={[
          { label: 'ID', value: project.projectId },
          { label: 'Default agent', value: project.defaultAgentId ?? '—' },
          { label: 'Memberships', value: detail.memberships.length },
          { label: 'Jobs', value: detail.jobs.length },
        ]}
      />

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      <div className="flex-1 overflow-auto bg-background">
        <div className="px-10 py-10 rise rise-2">
          {activeTab === 'overview' && <ProjectOverviewTab detail={detail} />}
          {activeTab === 'agents' && <ProjectAgentsTab detail={detail} />}
          {activeTab === 'jobs' && <ProjectJobsTab detail={detail} />}
          {activeTab === 'interfaces' && <ProjectInterfacesTab detail={detail} />}
          {activeTab === 'events' && <ProjectSystemEventsTab detail={detail} />}
          {activeTab === 'raw' && <ProjectRawTab detail={detail} />}
        </div>
      </div>
    </div>
  )
}
