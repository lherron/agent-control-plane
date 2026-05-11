import type { RouteObject } from 'react-router-dom'
import { JobsPage } from './jobs-page'

export const jobRoutes: RouteObject[] = [
  {
    path: 'jobs',
    element: <JobsPage />,
  },
]
