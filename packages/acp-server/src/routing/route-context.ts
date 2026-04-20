import type { ResolvedAcpServerDeps } from '../deps.js'

export type RouteParams = Record<string, string>

export type RouteContext = {
  request: Request
  url: URL
  params: RouteParams
  deps: ResolvedAcpServerDeps
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>
