import type { RouteObject } from 'react-router-dom'
import { AgentDetailPage } from './pages/agent-detail'
import { AgentsGlamProposalPage } from './pages/agents-glam-proposal'
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
        path: '__glam',
        element: <AgentsGlamProposalPage />,
      },
      {
        path: ':agentId',
        element: <AgentDetailPage />,
      },
    ],
  },
]
