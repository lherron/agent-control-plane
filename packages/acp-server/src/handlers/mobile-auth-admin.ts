/**
 * Loopback-only admin routes for mobile bearer auth (spec §2/§4).
 *
 * These exist so that **the server is the state file's only writer**: the CLI
 * never opens `mobile-auth.json`, it calls these. Two writers on one flat file is
 * the shape §4 rules out.
 *
 * The locality gate follows attach-info (T-07335) exactly: the socket peer must be
 * loopback, an unobservable peer is not loopback, and a bearer token never
 * substitutes for locality — minting a pairing code and arming enforcement are
 * operator-authority acts, not device-authority acts.
 */

import { badRequest, json } from '../http.js'
import { MobileAuthEmptyRosterError } from '../mobile-auth/store.js'
import { isLoopbackPeer } from '../routing/peer.js'

import type { ResolvedAcpServerDeps } from '../deps.js'
import type { MobileAuthStore } from '../mobile-auth/store.js'
import { isRecord } from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'

function notLocal(): Response {
  return json(
    {
      ok: false,
      code: 'not_local',
      message: 'mobile auth administration is served to loopback callers only',
    },
    404
  )
}

function requireMobileAuthStore(deps: ResolvedAcpServerDeps): MobileAuthStore {
  return deps.mobileAuthStore
}

async function readOptionalBody(request: Request): Promise<Record<string, unknown>> {
  const raw = (await request.text()).trim()
  if (raw.length === 0) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    badRequest('request body must be valid JSON')
  }
  if (!isRecord(parsed)) {
    badRequest('request body must be a JSON object')
  }
  return parsed
}

/** POST /v1/mobile/auth/pairing-code — mint the single outstanding pairing code. */
export const handleMintMobilePairingCode: RouteHandler = async ({ deps, peer }) => {
  if (!isLoopbackPeer(peer)) {
    return notLocal()
  }
  const minted = requireMobileAuthStore(deps).mintPairingCode()
  return json({ ok: true, ...minted })
}

/** GET /v1/mobile/auth/devices — roster + enforcement posture. No hashes leave here. */
export const handleListMobileAuthDevices: RouteHandler = async ({ deps, peer }) => {
  if (!isLoopbackPeer(peer)) {
    return notLocal()
  }
  return json({ ok: true, ...requireMobileAuthStore(deps).readPublicState() })
}

/** POST /v1/mobile/auth/devices/revoke — delete one device's stored hash. */
export const handleRevokeMobileAuthDevice: RouteHandler = async ({ deps, peer, request }) => {
  if (!isLoopbackPeer(peer)) {
    return notLocal()
  }
  const body = await readOptionalBody(request)
  const deviceId = body['deviceId']
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    badRequest('deviceId is required', { field: 'deviceId' })
  }

  const revoked = requireMobileAuthStore(deps).revokeDevice(deviceId.trim())
  if (revoked === undefined) {
    return json({ ok: false, code: 'not_found', message: `no paired device ${deviceId}` }, 404)
  }
  return json({ ok: true, revoked, ...requireMobileAuthStore(deps).readPublicState() })
}

/** POST /v1/mobile/auth/enforce — arm or disarm the gate (spec §4). */
export const handleSetMobileAuthEnforce: RouteHandler = async ({ deps, peer, request }) => {
  if (!isLoopbackPeer(peer)) {
    return notLocal()
  }
  const body = await readOptionalBody(request)
  const enforce = body['enforce']
  if (typeof enforce !== 'boolean') {
    badRequest('enforce must be a boolean', { field: 'enforce' })
  }

  const store = requireMobileAuthStore(deps)
  try {
    store.setEnforce(enforce, { force: body['force'] === true })
  } catch (error) {
    if (error instanceof MobileAuthEmptyRosterError) {
      // Spec §8 lockout guard: arming with an empty roster bricks every remote
      // client until a device pairs, so it takes an explicit --force.
      return json({ ok: false, code: 'empty_device_list', message: error.message }, 409)
    }
    throw error
  }
  return json({ ok: true, ...store.readPublicState() })
}
