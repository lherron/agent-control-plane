import type { RouteObject } from 'react-router-dom'
import { SchedulerPage } from './scheduler-page'

export const schedulerRoutes: RouteObject[] = [
  {
    path: 'scheduler',
    children: [
      {
        index: true,
        element: <SchedulerPage />,
      },
    ],
  },
]
