/**
 * GET /v1/health handler.
 *
 * Reports gateway liveness and probes HRC health + status to surface
 * capability flags for the iOS connection screen.
 */

import type { HrcClient } from 'hrc-sdk'
import { createLogger } from './logger.js'

const log = createLogger({ component: 'health' })

export type GatewayHealthResponse = {
  ok: true
  gatewayId: string
  apiVersion: 'v1'
  hrc: {
    ok: boolean
    apiVersion?: string | undefined
    error?: string | undefined
    capabilities?:
      | {
          sessions: boolean
          events: boolean
          messages: boolean
          literalInput: boolean
          appOwnedSessions: boolean
        }
      | undefined
  }
}

export async function handleHealth(
  client: HrcClient,
  gatewayId: string
): Promise<GatewayHealthResponse> {
  try {
    const [_health, status] = await Promise.all([client.getHealth(), client.getStatus()])

    return {
      ok: true,
      gatewayId,
      apiVersion: 'v1',
      hrc: {
        ok: true,
        apiVersion: status.apiVersion,
        capabilities: {
          sessions: status.capabilities.semanticCore.sessions,
          events: true, // HRC always supports events if status returned
          messages: true, // hrcchat messages always available
          literalInput: status.capabilities.platform.literalInput,
          appOwnedSessions: status.capabilities.platform.appOwnedSessions,
        },
      },
    }
  } catch (err) {
    log.warn('health.hrc_unreachable', {
      err: {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    })

    return {
      ok: true,
      gatewayId,
      apiVersion: 'v1',
      hrc: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}
