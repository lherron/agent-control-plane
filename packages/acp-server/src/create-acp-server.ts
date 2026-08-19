import { type AcpServerDeps, resolveAcpServerDeps } from './deps.js'
import { errorResponse } from './http.js'
import { buildExactRouteHandlers, exactRouteKey } from './routing/exact-routes.js'
import { buildParamRoutes, matchParamRoute } from './routing/param-routes.js'

import type { RequestPeer } from './routing/peer.js'

export type AcpServerHandlerOptions = {
  /**
   * Socket peer for this request (`server.requestIP(request)` under Bun.serve).
   * Omit only when the caller genuinely cannot observe it — peer-gated routes
   * fail closed rather than assuming local.
   */
  peer?: RequestPeer | undefined
}

export interface AcpServer {
  handler(request: Request, options?: AcpServerHandlerOptions): Promise<Response>
}

export function createAcpServer(deps: AcpServerDeps): AcpServer {
  const resolvedDeps = resolveAcpServerDeps(deps)
  const exactRouteHandlers = buildExactRouteHandlers(resolvedDeps)
  const paramRoutes = buildParamRoutes()

  return {
    async handler(request: Request, options?: AcpServerHandlerOptions): Promise<Response> {
      const peer = options?.peer
      try {
        const url = new URL(request.url)
        const pathname = url.pathname
        const exactRouteHandler = exactRouteHandlers[exactRouteKey(request.method, pathname)]
        if (exactRouteHandler !== undefined) {
          return await exactRouteHandler({ request, url, params: {}, deps: resolvedDeps, peer })
        }

        const matchedParamRoute = matchParamRoute(paramRoutes, request.method, pathname)
        if (matchedParamRoute !== undefined) {
          return await matchedParamRoute.handler({
            request,
            url,
            params: matchedParamRoute.params,
            deps: resolvedDeps,
            peer,
          })
        }

        return Response.json(
          {
            error: {
              code: 'not_found',
              message: 'route not found',
            },
          },
          { status: 404 }
        )
      } catch (error) {
        return errorResponse(error)
      }
    },
  }
}
