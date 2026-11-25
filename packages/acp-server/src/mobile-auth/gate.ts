/**
 * The single mobile-surface authorization decision (spec §1 table, §3).
 *
 * HTTP (`create-acp-server.ts`) and the Bun WS upgrade (`cli.ts`) both call this
 * one function, so the two paths cannot drift into different rules — which is the
 * whole point of §3. There is no per-handler auth code.
 */

import { writeLogLine } from 'acp-core'

import { MOBILE_API_ROOT, matchesMobileApiScope } from '../mobile-apis.js'
import { isLoopbackPeer } from '../routing/peer.js'

import type { RequestPeer } from '../routing/peer.js'
import type { MobileAuthStore } from './store.js'

/**
 * Route credential classes (spec §1).
 *
 * `exempt` — no credential, any peer: needed before a device has anything.
 * `pair`   — the pairing code is the credential; the handler owns that check,
 *            because bearer is never demanded on the issuance path.
 * `bearer` — everything else on the surface.
 * `strict` — Jobhunt and mobile API relay: bearer rules apply even with enforcement off.
 */
export type MobileRouteClass = 'exempt' | 'pair' | 'bearer' | 'strict'

const EXEMPT_PATHS = new Set(['/v1/mobile/health', '/v1/mobile/pairing'])
const PAIR_PATH = '/v1/mobile/pair'

/**
 * Every mobile-prefixed API version (`/v1/mobile/...`, `/v2/mobile/...`, ...),
 * present and future.
 *
 * `/v2/mobile/sessions` and the `/v2/mobile/dashboard` WS carry the same session
 * data as their `/v1` siblings; matching only `/v1` would leave exactly the hole
 * this gate exists to close. A future version's routes therefore land in the
 * bearer tier by default — the exempt set is an explicit allowlist, never a
 * prefix rule.
 */
const MOBILE_PATH_PATTERN = /^\/v\d+\/mobile\/.+$/

/** `undefined` means "not part of the mobile surface" — the gate does not apply. */
export function classifyMobileRoute(pathname: string): MobileRouteClass | undefined {
  if (!MOBILE_PATH_PATTERN.test(pathname)) {
    return undefined
  }
  if (pathname.startsWith('/v1/mobile/jobhunt/') || pathname.startsWith(MOBILE_API_ROOT)) {
    return 'strict'
  }
  if (EXEMPT_PATHS.has(pathname)) {
    return 'exempt'
  }
  if (pathname === PAIR_PATH) {
    return 'pair'
  }
  return 'bearer'
}

/** Extract a bearer token from an `Authorization` header value. */
export function parseBearerToken(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined) {
    return undefined
  }
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1]
}

type MobileAuthRefusal = 'unauthorized' | 'scope_denied'
export type MobileAuthDecision =
  | { kind: 'allow'; deviceId?: string | undefined }
  | { kind: MobileAuthRefusal }

export type MobileAuthorizeInput = {
  pathname: string
  peer: RequestPeer | undefined
  authorization: string | null | undefined
  store: MobileAuthStore
}

export function authorizeMobileRequest(input: MobileAuthorizeInput): MobileAuthDecision {
  const routeClass = classifyMobileRoute(input.pathname)
  if (routeClass === undefined || routeClass === 'exempt' || routeClass === 'pair') {
    return { kind: 'allow' }
  }

  const loopback = isLoopbackPeer(input.peer)
  const token = parseBearerToken(input.authorization)
  const device = token === undefined ? undefined : input.store.verifyToken(token)
  if (loopback) {
    return { kind: 'allow', deviceId: device?.deviceId ?? 'loopback' }
  }
  if (device !== undefined) {
    if (device.scope !== undefined && !matchesMobileApiScope(input.pathname, device.scope)) {
      writeLogLine({
        level: 'warn',
        component: 'mobile-auth',
        event: 'mobile.scope_denied',
        data: { path: input.pathname, deviceId: device.deviceId },
      })
      return { kind: 'scope_denied' }
    }
    return { kind: 'allow', deviceId: device.deviceId }
  }
  if (routeClass !== 'strict' && !input.store.isEnforcing()) {
    return { kind: 'allow' }
  }
  // Why, for the operator: a device that never paired sends nothing; a device paired elsewhere or revoked
  // sends a token this store does not hold. The class is logged, never the header's value (spec §2).
  const header = input.authorization
  writeLogLine({
    level: 'warn',
    component: 'mobile-auth',
    event: 'mobile.unauthorized',
    data: {
      path: input.pathname,
      remote: input.peer?.address,
      credential:
        header === null || header === undefined || header.trim() === ''
          ? 'absent'
          : token === undefined
            ? 'malformed'
            : 'invalid',
    },
  })
  return { kind: 'unauthorized' }
}

export function mobileAuthRefusalResponse(refusal: MobileAuthRefusal): Response {
  return refusal === 'scope_denied'
    ? Response.json({ ok: false, code: refusal }, { status: 403 })
    : mobileUnauthorizedResponse()
}

/**
 * The one 401 shape on this surface. Missing and invalid credentials are
 * deliberately indistinguishable: an identical body for both denies a prober the
 * "this token exists but is wrong" signal.
 */
export function mobileUnauthorizedResponse(): Response {
  return Response.json({ ok: false, code: 'unauthorized' }, { status: 401 })
}
