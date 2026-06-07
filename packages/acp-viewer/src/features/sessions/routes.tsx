import type { RouteObject } from 'react-router-dom'
import { SessionsLive } from './pages/sessions-live'

export const sessionRoutes: RouteObject[] = [
  {
    path: 'sessions',
    element: <SessionsLive />,
  },
]

