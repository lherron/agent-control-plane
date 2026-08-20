import type { Actor } from 'acp-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { RequestPeer } from './peer.js'

export type RouteParams = Record<string, string>

export type RouteContext = {
  request: Request
  url: URL
  params: RouteParams
  deps: ResolvedAcpServerDeps
  actor?: Actor | undefined
  /**
   * Socket peer for this request, when the listener threaded it through.
   * Undefined means "not observable" — gates that depend on it must fail closed.
   */
  peer?: RequestPeer | undefined
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>
