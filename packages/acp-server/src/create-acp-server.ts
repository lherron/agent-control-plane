import { type AcpServerDeps, resolveAcpServerDeps } from './deps.js'
import { errorResponse } from './http.js'
import { buildExactRouteHandlers, exactRouteKey } from './routing/exact-routes.js'
import { buildParamRoutes, matchParamRoute } from './routing/param-routes.js'

export interface AcpServer {
  handler(request: Request): Promise<Response>
}

export function createAcpServer(deps: AcpServerDeps): AcpServer {
  const resolvedDeps = resolveAcpServerDeps(deps)
  const exactRouteHandlers = buildExactRouteHandlers(resolvedDeps)
  const paramRoutes = buildParamRoutes()

  return {
    async handler(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const pathname = url.pathname
        const exactRouteHandler = exactRouteHandlers[exactRouteKey(request.method, pathname)]
        if (exactRouteHandler !== undefined) {
          return await exactRouteHandler({ request, url, params: {}, deps: resolvedDeps })
        }

        const matchedParamRoute = matchParamRoute(paramRoutes, request.method, pathname)
        if (matchedParamRoute !== undefined) {
          return await matchedParamRoute.handler({
            request,
            url,
            params: matchedParamRoute.params,
            deps: resolvedDeps,
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
