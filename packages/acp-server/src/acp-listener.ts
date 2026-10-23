/**
 * The Bun.serve `fetch` + `websocket` handlers for one ACP TCP listener: the
 * plugin-events and mobile WebSocket upgrades, island CORS, `/v1/cap/rpc`, and
 * the HTTP router, each logging its request line (request-log.ts) with the
 * route template of whichever branch matched.
 */
import type { ServerWebSocket } from 'bun'

import type { AccessLogger } from './access-log.js'
import type { AcpServer } from './create-acp-server.js'
import type { ResolvedAcpServerDeps } from './deps.js'
import { buildMobileUpgradeData, parseMobileRouteKind } from './handlers/mobile-ws.js'
import {
  closeMobileWebSocket,
  handleMobileWebSocketMessage,
  openMobileWebSocket,
} from './handlers/mobile.js'
import {
  PLUGIN_EVENTS_WS_PATH,
  buildPluginEventsUpgradeData,
  closePluginEventsWebSocket,
  handlePluginEventsWebSocketMessage,
  isPluginEventsWebSocketData,
  isPluginEventsWebSocketPath,
  openPluginEventsWebSocket,
} from './handlers/plugin-events-ws.js'
import { islandCorsOrigin, islandPreflight, withIslandCors } from './island-cors.js'
import { authorizeMobileRequest, mobileUnauthorizedResponse } from './mobile-auth/gate.js'
import {
  MAIN_LISTENER,
  type RequestLogContext,
  finishRequestLog,
  logWebSocketClose,
  logWebSocketOpen,
  readMobileSessionRequestId,
  startRequestLog,
} from './request-log.js'

export const CAP_RPC_PATH = '/v1/cap/rpc'

type UpgradeServer = {
  requestIP(request: Request): { address: string; family: string; port: number } | null
  upgrade(request: Request, options: unknown): boolean
}

export interface AcpListenerOptions {
  acpServer: AcpServer
  deps: ResolvedAcpServerDeps
  handleCapRpc(request: Request): Promise<Response>
  accessLogger?: AccessLogger | null | undefined
  listener?: string | undefined
}

export function createAcpListenerHandlers(options: AcpListenerOptions) {
  const { acpServer, deps } = options
  const listener = options.listener ?? MAIN_LISTENER
  // Upgrade data object -> its request log, so a socket's close logs its lifetime.
  const openWebSockets = new WeakMap<object, RequestLogContext>()

  function trackWebSocket(data: object, requestLog: RequestLogContext): undefined {
    openWebSockets.set(data, requestLog)
    logWebSocketOpen(requestLog)
    return undefined
  }

  function upgrade(
    server: UpgradeServer,
    request: Request,
    data: object,
    requestLog: RequestLogContext
  ): Response | undefined {
    return server.upgrade(request, { data })
      ? trackWebSocket(data, requestLog)
      : finishRequestLog(requestLog, new Response('WebSocket upgrade failed', { status: 400 }))
  }

  return {
    async fetch(request: Request, server: UpgradeServer): Promise<Response | undefined> {
      const url = new URL(request.url)
      // Socket peer, captured before the body is consumed and before the WS
      // branch: Bun exposes it only here, and peer-gated routes (mobile bearer
      // auth, attach-info) cannot observe it from the Request alone.
      const peer = server.requestIP(request) ?? undefined
      const requestLog = startRequestLog(request, url, peer?.address, listener)
      const isWebSocketUpgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      if (isWebSocketUpgrade && isPluginEventsWebSocketPath(url.pathname)) {
        requestLog.route = PLUGIN_EVENTS_WS_PATH
        return upgrade(server, request, buildPluginEventsUpgradeData(deps, request.url), requestLog)
      }
      const mobileWsMatch = isWebSocketUpgrade ? parseMobileRouteKind(url.pathname) : undefined
      if (mobileWsMatch !== undefined) {
        requestLog.route = mobileWsMatch.route
        // Same decision function as the HTTP router (spec §3) — checked before
        // `server.upgrade()`, since a socket that completes the handshake is
        // already inside.
        if (
          authorizeMobileRequest({
            pathname: url.pathname,
            peer,
            authorization: request.headers.get('authorization'),
            store: deps.mobileAuthStore,
          }) === 'unauthorized'
        ) {
          return finishRequestLog(requestLog, mobileUnauthorizedResponse())
        }
        return upgrade(
          server,
          request,
          buildMobileUpgradeData(deps, request.url, mobileWsMatch),
          requestLog
        )
      }

      const islandOrigin = islandCorsOrigin(request, peer)
      if (islandOrigin !== undefined && request.method === 'OPTIONS') {
        // A preflight is logged against the route it clears the way for.
        const preflightedMethod = request.headers.get('access-control-request-method') ?? 'GET'
        requestLog.route =
          url.pathname === CAP_RPC_PATH
            ? CAP_RPC_PATH
            : acpServer.routeTemplate(preflightedMethod, url.pathname)
        return finishRequestLog(requestLog, islandPreflight(islandOrigin, request))
      }
      const start = performance.now()
      requestLog.requestId = await readMobileSessionRequestId(request, url)
      let handled: Response
      if (url.pathname === CAP_RPC_PATH) {
        requestLog.route = CAP_RPC_PATH
        handled = await options.handleCapRpc(request)
      } else {
        handled = await acpServer.handler(request, {
          peer,
          onRoute: (route) => {
            requestLog.route = route
          },
        })
      }
      const response = islandOrigin === undefined ? handled : withIslandCors(handled, islandOrigin)
      if (options.accessLogger) {
        options.accessLogger.log({
          request,
          response,
          durationMs: Math.round(performance.now() - start),
          clientIp: peer?.address,
        })
      }
      return finishRequestLog(requestLog, response)
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        if (isPluginEventsWebSocketData(ws.data)) {
          void openPluginEventsWebSocket(ws as never)
          return
        }
        void openMobileWebSocket(ws as never).catch((error) => {
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'mobile_stream_failed',
                message: error instanceof Error ? error.message : String(error),
              })
            )
            // T-10837: close, or the client sits on an open, silent socket
            // (the dashboard's ping timer is already cleared).
            ws.close(1011, 'mobile stream failed')
          } catch {
            // Socket may already be closed.
          }
        })
      },
      message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
        if (isPluginEventsWebSocketData(ws.data)) {
          handlePluginEventsWebSocketMessage(ws as never, message as never)
          return
        }
        handleMobileWebSocketMessage(ws as never, message as never)
      },
      close(ws: ServerWebSocket<unknown>, code: number) {
        const tracked = openWebSockets.get(ws.data as object)
        if (tracked !== undefined) logWebSocketClose(tracked, code)
        if (isPluginEventsWebSocketData(ws.data)) {
          closePluginEventsWebSocket(ws as never)
          return
        }
        closeMobileWebSocket(ws as never)
      },
    },
  }
}
