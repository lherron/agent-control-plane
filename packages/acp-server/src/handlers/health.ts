import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'

/**
 * Process liveness: answers from this process alone, with no database read
 * and no HRC call, so a probe at one request a minute (Foundry's incident
 * handler) can ask "is acp-server up" without touching anything it watches.
 * Readiness of dependencies is a different question: GET /v1/mobile/health
 * asks HRC.
 */
const STARTED_AT = new Date().toISOString()

export const handleHealth: RouteHandler = async () =>
  json({
    ok: true,
    service: 'acp-server',
    pid: process.pid,
    startedAt: STARTED_AT,
    uptimeSec: Math.floor(process.uptime()),
  })
