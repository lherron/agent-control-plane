import type { RouteObject } from 'react-router-dom'
import { AgentsPage } from './agents-page'

export const agentRoutes: RouteObject[] = [
  {
    path: 'agents',
    element: <AgentsPage />,
  },
]
