/**
 * The single mobile-surface authorization decision (spec §1 table, §3).
 *
 * HTTP (`create-acp-server.ts`) and the Bun WS upgrade (`cli.ts`) both call this
 * one function, so the two paths cannot drift into different rules — which is the
 * whole point of §3. There is no per-handler auth code.
 */

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
 */
export type MobileRouteClass = 'exempt' | 'pair' | 'bearer'

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

export type MobileAuthDecision = 'allow' | 'unauthorized'

export type MobileAuthorizeInput = {
  pathname: string
  peer: RequestPeer | undefined
  authorization: string | null | undefined
  store: MobileAuthStore
}

export function authorizeMobileRequest(input: MobileAuthorizeInput): MobileAuthDecision {
  const routeClass = classifyMobileRoute(input.pathname)
  if (routeClass === undefined || routeClass === 'exempt') {
    return 'allow'
  }

  // Dark ship (spec §4 step 1): `enforce: false` is zero behavior change across
  // the whole table, including the pair route's tailnet denial. Redemption is
  // unconditional — a valid code mints a token whether or not enforcement is on —
  // so the flag gates only refusals, never issuance.
  if (!input.store.isEnforcing()) {
    return 'allow'
  }

  // The pairing code is the pair route's credential and the handler checks it;
  // demanding a bearer here would make pairing impossible by construction.
  if (routeClass === 'pair') {
    return 'allow'
  }

  if (isLoopbackPeer(input.peer)) {
    return 'allow'
  }

  const token = parseBearerToken(input.authorization)
  if (token === undefined) {
    return 'unauthorized'
  }
  return input.store.verifyToken(token) ? 'allow' : 'unauthorized'
}

/**
 * The one 401 shape on this surface. Missing and invalid credentials are
 * deliberately indistinguishable: an identical body for both denies a prober the
 * "this token exists but is wrong" signal.
 */
export function mobileUnauthorizedResponse(): Response {
  return Response.json({ ok: false, code: 'unauthorized' }, { status: 401 })
}
