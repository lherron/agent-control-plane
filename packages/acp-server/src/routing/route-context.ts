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
  /** Attribution from the shared mobile gate, including tokenless loopback. */
  mobileDeviceId?: string | undefined
  /** Switch the listener to the discard timeout when an upload is rejected mid-read. */
  onDiscardRequestBody?: (() => void) | undefined
  /** End a failed streaming hop without completing the HTTP response framing. */
  abortResponseStream?: (() => void) | undefined
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>
