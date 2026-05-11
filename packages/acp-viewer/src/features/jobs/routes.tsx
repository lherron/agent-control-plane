import type { RouteObject } from 'react-router-dom'
import { JobDetail } from './pages/job-detail'
import { JobFlow } from './pages/job-flow'
import { JobsCatalog } from './pages/jobs-catalog'

export const jobRoutes: RouteObject[] = [
  {
    path: 'jobs',
    children: [
      {
        index: true,
        element: <JobsCatalog />,
      },
      {
        path: ':jobId',
        element: <JobDetail />,
      },
      {
        path: ':jobId/flow',
        element: <JobFlow />,
      },
    ],
  },
]
