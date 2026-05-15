import type { RouteObject } from 'react-router-dom'
import { AgentDetailPage } from './pages/agent-detail'
import { AgentsCataloguePage } from './pages/agents-catalogue'

export const agentRoutes: RouteObject[] = [
  {
    path: 'agents',
    children: [
      {
        index: true,
        element: <AgentsCataloguePage />,
      },
      {
        path: ':agentId',
        element: <AgentDetailPage />,
      },
    ],
  },
]
