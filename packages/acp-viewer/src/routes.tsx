import { agentRoutes } from '@/features/agents/routes'
import { jobRoutes } from '@/features/jobs/routes'
import { projectRoutes } from '@/features/projects/routes'
import { schedulerRoutes } from '@/features/scheduler/routes'
import type { RouteObject } from 'react-router-dom'
import { Navigate } from 'react-router-dom'

export const appRoutes: RouteObject[] = [
  {
    index: true,
    element: <Navigate to="/jobs" replace />,
  },
  ...projectRoutes,
  ...agentRoutes,
  ...jobRoutes,
  ...schedulerRoutes,
]
