import { type AcpServerDeps, resolveAcpServerDeps } from './deps.js'
import { errorResponse } from './http.js'
import { authorizeMobileRequest, mobileUnauthorizedResponse } from './mobile-auth/gate.js'
import { UNMATCHED_ROUTE } from './request-log.js'
import { buildExactRouteHandlers, exactRouteKey } from './routing/exact-routes.js'
import { buildParamRoutes, matchParamRoute } from './routing/param-routes.js'

import type { RequestPeer } from './routing/peer.js'
import type { RouteHandler, RouteParams } from './routing/route-context.js'

export type AcpServerHandlerOptions = {
  /**
   * Socket peer for this request (`server.requestIP(request)` under Bun.serve).
   * Omit only when the caller genuinely cannot observe it — peer-gated routes
   * fail closed rather than assuming local.
   */
  peer?: RequestPeer | undefined
  /**
   * Told the registered template of the route that matched (exact path or
   * param pattern), or `unmatched`, before the handler runs. The request log's
   * `route` field comes from here.
   */
  onRoute?: ((route: string) => void) | undefined
}

export interface AcpServer {
  handler(request: Request, options?: AcpServerHandlerOptions): Promise<Response>
  /** The template `method pathname` would route to, without running it. */
  routeTemplate(method: string, pathname: string): string
}

type MatchedRoute = { template: string; handler: RouteHandler; params: RouteParams }

export function createAcpServer(deps: AcpServerDeps): AcpServer {
  const resolvedDeps = resolveAcpServerDeps(deps)
  const exactRouteHandlers = buildExactRouteHandlers(resolvedDeps)
  const paramRoutes = buildParamRoutes()

  function matchRoute(method: string, pathname: string): MatchedRoute | undefined {
    const exactRouteHandler = exactRouteHandlers[exactRouteKey(method, pathname)]
    if (exactRouteHandler !== undefined) {
      return { template: pathname, handler: exactRouteHandler, params: {} }
    }
    return matchParamRoute(paramRoutes, method, pathname)
  }

  return {
    routeTemplate(method: string, pathname: string): string {
      return matchRoute(method, pathname)?.template ?? UNMATCHED_ROUTE
    },

    async handler(request: Request, options?: AcpServerHandlerOptions): Promise<Response> {
      const peer = options?.peer
      try {
        const url = new URL(request.url)
        const pathname = url.pathname
        const matched = matchRoute(request.method, pathname)
        options?.onRoute?.(matched?.template ?? UNMATCHED_ROUTE)

        // Single enforcement point for the mobile surface (spec §3): one decision
        // function, shared with the WS upgrade path in `cli.ts`, ahead of the
        // route handlers so no handler carries auth code of its own.
        if (
          authorizeMobileRequest({
            pathname,
            peer,
            authorization: request.headers.get('authorization'),
            store: resolvedDeps.mobileAuthStore,
          }) === 'unauthorized'
        ) {
          return mobileUnauthorizedResponse()
        }

        if (matched !== undefined) {
          return await matched.handler({
            request,
            url,
            params: matched.params,
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
