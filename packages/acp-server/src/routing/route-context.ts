import type { Actor } from 'acp-core'

import type { ResolvedAcpServerDeps } from '../deps.js'

export type RouteParams = Record<string, string>

export type RouteContext = {
  request: Request
  url: URL
  params: RouteParams
  deps: ResolvedAcpServerDeps
  actor?: Actor | undefined
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>
