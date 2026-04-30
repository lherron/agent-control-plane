/**
 * GatewayIosModule — lifecycle entry point.
 *
 * Constructs an HrcClient against the configured Unix socket, builds the
 * REST + WebSocket route surface from createGatewayIosServeConfig, and
 * binds a Bun.serve listener on the configured host/port. Optional bearer
 * token enforcement runs in front of the route table.
 */

import type { Server } from 'bun'
import { HrcClient } from 'hrc-sdk'
import { createLogger } from './logger.js'
import { type WsData, createGatewayIosServeConfig } from './routes.js'
import { createSessionIndex } from './session-index.js'

const log = createLogger({ component: 'gateway-ios' })

export type GatewayIosModuleOptions = {
  hrcSocketPath: string
  host?: string | undefined
  port?: number | undefined
  bearerToken?: string | undefined
  gatewayId?: string | undefined
}

export type GatewayIosModule = {
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}

export function createGatewayIosModule(options: GatewayIosModuleOptions): GatewayIosModule {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 18480
  const gatewayId = options.gatewayId ?? 'ios-local'
  const bearerToken = options.bearerToken

  let server: Server<WsData> | undefined

  return {
    async start() {
      if (server) {
        throw new Error('gateway-ios is already running')
      }

      log.info('gateway.starting', {
        data: { host, port, gatewayId, hrcSocketPath: options.hrcSocketPath },
      })

      const hrcClient = new HrcClient(options.hrcSocketPath)
      const sessionIndex = createSessionIndex({ client: hrcClient })

      const serveConfig = createGatewayIosServeConfig({
        hrcClient,
        gatewayId,
        resolveSession: async ({ sessionRef, hostSessionId, generation }) => {
          const { sessions } = await sessionIndex.handleListSessions({})
          const candidates = sessions.filter((s) => s.sessionRef === sessionRef)
          const match =
            hostSessionId !== undefined
              ? candidates.find(
                  (s) =>
                    s.hostSessionId === hostSessionId &&
                    (generation === undefined || s.generation === generation)
                )
              : ([...candidates]
                  .filter((s) => s.status === 'active')
                  .sort((a, b) => b.generation - a.generation)[0] ??
                [...candidates].sort((a, b) => b.generation - a.generation)[0])
          if (!match) {
            throw new Error(`session not found: ${sessionRef}`)
          }
          return match
        },
      })

      server = Bun.serve<WsData, never>({
        hostname: host,
        port,
        fetch: async (request, srv) => {
          if (bearerToken !== undefined) {
            const auth = request.headers.get('authorization')
            if (auth !== `Bearer ${bearerToken}`) {
              return new Response(JSON.stringify({ ok: false, code: 'unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              })
            }
          }
          const response = await serveConfig.fetch(request, srv as Server<WsData>)
          return response ?? new Response(null, { status: 101 })
        },
        websocket: serveConfig.websocket,
      }) as Server<WsData>

      log.info('gateway.started', {
        data: { host, port, gatewayId, bearerTokenConfigured: bearerToken !== undefined },
      })

      return { host, port }
    },

    async stop() {
      if (!server) return
      log.info('gateway.stopping', { data: { gatewayId } })
      server.stop(true)
      server = undefined
      log.info('gateway.stopped', { data: { gatewayId } })
    },
  }
}
