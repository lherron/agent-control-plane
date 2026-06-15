import type { Server, ServerWebSocket } from 'bun'
import type { HrcClient } from 'hrc-sdk'

import type { MobileSessionSummary } from './contracts.js'
import { type DiagnosticsWsData, createDiagnosticsWsHandler } from './diagnostics-ws.js'
import { handleHealth } from './health.js'
import { handleInput, handleInterrupt } from './input.js'
import type { InputHandlerDeps } from './input.js'
import { createLogger } from './logger.js'
import { createSessionIndex } from './session-index.js'
import { handleHistoryRequest } from './timeline-history.js'
import { type TimelineWsData, createTimelineWsHandler } from './timeline-ws.js'

const log = createLogger({ component: 'routes' })

// ---------------------------------------------------------------------------
// WS proxy: present route-specific data to handlers without mutating ws.data
// ---------------------------------------------------------------------------

/**
 * Create a lightweight proxy that wraps a ServerWebSocket<WsData> and
 * presents it as ServerWebSocket<T> by overriding the `data` property.
 * This avoids mutating ws.data (which breaks the route discriminator).
 */
function createWsProxy<T>(ws: ServerWebSocket<WsData>, data: T): ServerWebSocket<T> {
  return {
    get data() {
      return data
    },
    send: ws.send.bind(ws),
    close: ws.close.bind(ws),
    // Forward other properties that handlers might need
    get readyState() {
      return ws.readyState
    },
    get remoteAddress() {
      return ws.remoteAddress
    },
  } as unknown as ServerWebSocket<T>
}

export type GatewayIosRoute = {
  method: string
  path: string
  handle(request: Request): Promise<Response>
}

export type GatewayIosRoutes = GatewayIosRoute[] & {
  fetch(request: Request): Promise<Response>
}

/** Combined WS data union — Bun needs a single type for all WS connections. */
export type WsData = {
  route: 'timeline' | 'diagnostics'
  timeline?: TimelineWsData | undefined
  diagnostics?: DiagnosticsWsData | undefined
}

export type GatewayIosRouteDeps = {
  hrcClient: HrcClient
  gatewayId: string
  /** Session resolver for timeline WS. Omitted hostSessionId means active/latest for that sessionRef. */
  resolveSession?:
    | ((selector: {
        sessionRef: string
        hostSessionId?: string | undefined
        generation?: number | undefined
      }) => Promise<MobileSessionSummary>)
    | undefined
}

function notFound(): Response {
  return new Response(JSON.stringify({ ok: false, code: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseSessionQuery(url: URL): { mode?: string; status?: string; q?: string } {
  const filter: { mode?: string; status?: string; q?: string } = {}
  const mode = url.searchParams.get('mode')
  const status = url.searchParams.get('status')
  const q = url.searchParams.get('q')
  if (mode !== null) filter.mode = mode
  if (status !== null) filter.status = status
  if (q !== null) filter.q = q
  return filter
}

export function createGatewayIosRoutes(deps: GatewayIosRouteDeps): GatewayIosRoutes {
  const sessionIndex = createSessionIndex({ client: deps.hrcClient })
  const inputDeps: InputHandlerDeps = {
    hrcClient: deps.hrcClient as unknown as InputHandlerDeps['hrcClient'],
  }

  const routes: GatewayIosRoute[] = []

  // -- P5: health + session index + sessions/refresh --
  // Phase-local route tests may construct only the deps their route owns.
  if (deps.gatewayId !== undefined) {
    routes.push({
      method: 'GET',
      path: '/v1/health',
      handle: async () => Response.json(await handleHealth(deps.hrcClient, deps.gatewayId)),
    })
    routes.push({
      method: 'GET',
      path: '/v1/sessions',
      handle: async (request) => {
        const url = new URL(request.url)
        return Response.json(await sessionIndex.handleListSessions(parseSessionQuery(url)))
      },
    })
    routes.push({
      method: 'POST',
      path: '/v1/sessions/refresh',
      handle: async (request) => {
        const url = new URL(request.url)
        return Response.json(await sessionIndex.handleRefresh(parseSessionQuery(url)))
      },
    })

    // -- P4: progressive history --
    routes.push({
      method: 'GET',
      path: '/v1/history',
      handle: (request) => handleHistoryRequest(request, { hrcClient: deps.hrcClient }),
    })
  }

  // -- P6: input + interrupt --
  routes.push({
    method: 'POST',
    path: '/v1/input',
    handle: (request) => handleInput(request, inputDeps),
  })
  routes.push({
    method: 'POST',
    path: '/v1/interrupt',
    handle: (request) => handleInterrupt(request, inputDeps),
  })

  return Object.assign(routes, {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const route = routes.find(
        (candidate) => candidate.method === request.method && candidate.path === url.pathname
      )
      if (!route) return notFound()
      return await route.handle(request)
    },
  })
}

export function createGatewayIosFetchHandler(
  deps: GatewayIosRouteDeps
): (request: Request) => Promise<Response> {
  return createGatewayIosRoutes(deps).fetch
}

// ---------------------------------------------------------------------------
// P3: WebSocket handlers (timeline + diagnostics)
// ---------------------------------------------------------------------------

/**
 * Create WebSocket handlers for timeline and diagnostics routes.
 * Returns Bun.serve-compatible websocket config and a WS upgrade handler.
 *
 * Usage in P7 composition:
 * ```ts
 * const wsHandlers = createGatewayIosWsHandlers(deps)
 * Bun.serve({
 *   fetch(req, server) {
 *     const wsResult = wsHandlers.tryUpgrade(req, server)
 *     if (wsResult === undefined) return undefined // Upgrade succeeded
 *     if (wsResult !== null) return wsResult // Error response
 *     return restRoutes.fetch(req) // Fall through to REST
 *   },
 *   websocket: wsHandlers.websocket,
 * })
 * ```
 */
export function createGatewayIosWsHandlers(deps: GatewayIosRouteDeps) {
  const timelineHandler = createTimelineWsHandler({
    hrcClient: deps.hrcClient,
    historyClient: deps.hrcClient,
    resolveSession:
      deps.resolveSession ??
      (async () => {
        throw new Error('resolveSession not configured')
      }),
  })

  const diagnosticsHandler = createDiagnosticsWsHandler({
    hrcClient: deps.hrcClient,
  })

  /**
   * Resolve the lifecycle callbacks for a connection's route, each already
   * bound to a proxy presenting the route-specific data. Returns undefined for
   * an unknown/mismatched route so callers can reject it. Centralizes the
   * route→handler dispatch that the open/message/close callbacks all share.
   */
  function resolveRouteHandler(data: WsData):
    | {
        open(ws: ServerWebSocket<WsData>): void
        message(ws: ServerWebSocket<WsData>, message: string | Buffer): void
        close(ws: ServerWebSocket<WsData>): void
      }
    | undefined {
    if (data.route === 'timeline' && data.timeline) {
      const routeData = data.timeline
      return {
        open: (ws) => timelineHandler.open(createWsProxy(ws, routeData)),
        message: (ws, message) => timelineHandler.message(createWsProxy(ws, routeData), message),
        close: (ws) => timelineHandler.close(createWsProxy(ws, routeData)),
      }
    }
    if (data.route === 'diagnostics' && data.diagnostics) {
      const routeData = data.diagnostics
      return {
        open: (ws) => diagnosticsHandler.open(createWsProxy(ws, routeData)),
        message: (ws, message) => diagnosticsHandler.message(createWsProxy(ws, routeData), message),
        close: (ws) => diagnosticsHandler.close(createWsProxy(ws, routeData)),
      }
    }
    return undefined
  }

  return {
    /**
     * Attempt WS upgrade. Returns:
     * - undefined: upgrade succeeded (Bun handles the WS connection)
     * - Response: error (missing param, upgrade failed)
     * - null: path is not a WS route, fall through to REST
     */
    tryUpgrade(req: Request, server: Server<WsData>): Response | undefined | null {
      const url = new URL(req.url)

      if (url.pathname === '/v1/timeline') {
        // sessionRef is a lineage/display selector. When hostSessionId is not
        // present, the timeline handler resolves active/latest for that
        // sessionRef only; it must never stream all sibling generations.
        const data = timelineHandler.parseUpgrade(url)
        if (!data) {
          return new Response(
            JSON.stringify({ error: 'Missing required query param: sessionRef' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }

        const wsData: WsData = { route: 'timeline', timeline: data }
        const upgraded = server.upgrade(req, { data: wsData })
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 })
        }
        return undefined
      }

      if (url.pathname === '/v1/diagnostics/events') {
        // Same selector rule as timeline: absent hostSessionId means
        // active/latest for this sessionRef, not all generations.
        const data = diagnosticsHandler.parseUpgrade(url)
        if (!data) {
          return new Response(
            JSON.stringify({ error: 'Missing required query param: sessionRef' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
        }

        const wsData: WsData = { route: 'diagnostics', diagnostics: data }
        const upgraded = server.upgrade(req, { data: wsData })
        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 500 })
        }
        return undefined
      }

      return null // Not a WS route
    },

    /** Bun.serve websocket config object. */
    websocket: {
      open(ws: ServerWebSocket<WsData>): void {
        const handler = resolveRouteHandler(ws.data)
        if (!handler) {
          log.warn('routes.ws_unknown_route', { data: { route: ws.data.route } })
          ws.close(1008, 'Unknown route')
          return
        }
        handler.open(ws)
      },

      message(ws: ServerWebSocket<WsData>, message: string | Buffer): void {
        resolveRouteHandler(ws.data)?.message(ws, message)
      },

      close(ws: ServerWebSocket<WsData>, _code: number, _reason: string): void {
        resolveRouteHandler(ws.data)?.close(ws)
      },
    },
  }
}

/**
 * Create Bun.serve-compatible config with both REST and WS support.
 * Returns { fetch, websocket } to spread into Bun.serve().
 */
export function createGatewayIosServeConfig(deps: GatewayIosRouteDeps) {
  const restRoutes = createGatewayIosRoutes(deps)
  const wsHandlers = createGatewayIosWsHandlers(deps)

  return {
    async fetch(request: Request, server: Server<WsData>): Promise<Response | undefined> {
      // Try WS upgrade first
      const wsResult = wsHandlers.tryUpgrade(request, server)
      if (wsResult === undefined) return undefined // Upgrade succeeded
      if (wsResult !== null) return wsResult // Error response

      // Fall through to REST
      return restRoutes.fetch(request)
    },

    websocket: wsHandlers.websocket,
  }
}
