import type { RouteObject } from 'react-router-dom'
import { SchedulerStatePage } from './pages/scheduler-state'

export const schedulerRoutes: RouteObject[] = [
  {
    path: 'scheduler',
    children: [
      {
        index: true,
        element: <SchedulerStatePage />,
      },
    ],
  },
]
