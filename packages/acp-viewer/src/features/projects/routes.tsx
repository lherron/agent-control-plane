import type { RouteObject } from 'react-router-dom'
import { ProjectDetailPage } from './pages/project-detail'
import { ProjectsListPage } from './pages/projects-list'

export const projectRoutes: RouteObject[] = [
  {
    path: 'projects',
    children: [
      {
        index: true,
        element: <ProjectsListPage />,
      },
      {
        path: ':projectId',
        element: <ProjectDetailPage />,
      },
    ],
  },
]
