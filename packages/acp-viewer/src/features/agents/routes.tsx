import type { RouteObject } from 'react-router-dom'
import { AgentDetailPage } from './pages/agent-detail'
import { AgentsListPage } from './pages/agents-list'

export const agentRoutes: RouteObject[] = [
  {
    path: 'agents',
    children: [
      {
        index: true,
        element: <AgentsListPage />,
      },
      {
        path: ':agentId',
        element: <AgentDetailPage />,
      },
    ],
  },
]
