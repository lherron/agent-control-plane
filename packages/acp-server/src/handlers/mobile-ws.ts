/**
 * Shared mobile WebSocket transport/lifecycle helpers.
 *
 * Extracted from `./mobile.ts` and the Bun WS upgrade in `../cli.ts` so the
 * timeline and diagnostics handlers (and, later, the dashboard handler in
 * T-01507/P5) can share route parsing, cursor parsing, envelope sends, error
 * envelope emission, and AbortController cleanup without duplicating bugs.
 *
 * This module owns transport/lifecycle only. Event/message projection lives in
 * `./mobile.ts` (and projection rewrites belong to later subtasks).
 */
import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'

export type MobileRouteKind = 'timeline' | 'diagnostics' | 'dashboard'

export const MOBILE_WS_PATHS = {
  timeline: '/v1/mobile/timeline',
  diagnostics: '/v1/mobile/diagnostics',
  dashboard: '/v1/mobile/dashboard',
} as const

export type MobileWebSocketData = {
  deps: ResolvedAcpServerDeps
  url: string
  kind: MobileRouteKind
  abortController: AbortController
}

export type MobileWebSocketLike = {
  data: MobileWebSocketData
  send(message: string): number | undefined
  close(code?: number, reason?: string): void
}

/**
 * Parses the path of an incoming WebSocket upgrade request to the mobile route
 * kind, or `undefined` when the path is not a recognized mobile WS endpoint.
 */
export function parseMobileRouteKind(pathname: string): MobileRouteKind | undefined {
  if (pathname === MOBILE_WS_PATHS.timeline) return 'timeline'
  if (pathname === MOBILE_WS_PATHS.diagnostics) return 'diagnostics'
  if (pathname === MOBILE_WS_PATHS.dashboard) return 'dashboard'
  return undefined
}

/**
 * Builds the `data` payload attached to a Bun WebSocket upgrade for a mobile
 * route. The returned object is intentionally shaped to match
 * `MobileWebSocketData` so handlers can read it directly off `ws.data`.
 */
export function buildMobileUpgradeData(
  deps: ResolvedAcpServerDeps,
  url: string,
  kind: MobileRouteKind
): MobileWebSocketData {
  return {
    deps,
    url,
    kind,
    abortController: new AbortController(),
  }
}

/**
 * Parses the HRC event watch cursor from a mobile WebSocket request URL.
 *
 * Preserves the historical behavior of the per-handler parser:
 *   - `fromHrcSeq` is clamped to `>= 1` and defaults to 1 when missing/NaN.
 *   - `follow` is `true` only when the literal string `'true'` is supplied.
 *   - `hostSessionId` is forwarded when the param is present (even empty).
 *   - `generation` is forwarded only when the value parses as a finite number.
 *
 * Returns a shape compatible with `AcpHrcClient.watch`'s first argument so
 * callers can spread it directly.
 */
export function parseMobileEventCursor(url: URL): Parameters<AcpHrcClient['watch']>[0] {
  const fromSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '1', 10)
  const generation = Number.parseInt(url.searchParams.get('generation') ?? '', 10)
  return {
    fromSeq: Number.isFinite(fromSeq) ? Math.max(1, fromSeq) : 1,
    follow: url.searchParams.get('follow') === 'true',
    ...(url.searchParams.get('hostSessionId') !== null
      ? { hostSessionId: url.searchParams.get('hostSessionId') ?? undefined }
      : {}),
    ...(Number.isFinite(generation) ? { generation } : {}),
  }
}

/**
 * Parses the optional `fromMessageSeq` query param to a raw `parseInt` result.
 * Returns `NaN` when the param is present but unparseable; defaults to `0`
 * only when the param is absent. Callers should use `Number.isFinite()` to
 * gate spreading the value into downstream filter options, matching the
 * historical pattern in `openMobileWebSocket`.
 */
export function parseMobileMessageCursor(url: URL): number {
  return Number.parseInt(url.searchParams.get('fromMessageSeq') ?? '0', 10)
}

/** Parses the `raw=true` query flag using the historical strict-string check. */
export function parseMobileRawFlag(url: URL): boolean {
  return url.searchParams.get('raw') === 'true'
}

/**
 * JSON-encodes `message` and pushes it through the socket. Catches synchronous
 * send failures (e.g. socket already closed) and logs them so a single bad
 * frame can't kill the streaming loop. Returns `true` on success.
 */
export function sendMobileJsonEnvelope(
  ws: Pick<MobileWebSocketLike, 'send'>,
  message: unknown
): boolean {
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch (error) {
    console.warn('mobile ws send failed:', error instanceof Error ? error.message : String(error))
    return false
  }
}

export type MobileErrorEnvelope = {
  type: 'error'
  code: string
  message: string
}

/** Constructs the canonical mobile WS error envelope (no side effects). */
export function buildMobileErrorEnvelope(code: string, message: string): MobileErrorEnvelope {
  return { type: 'error', code, message }
}

/**
 * Convenience wrapper that builds and sends a typed error envelope through
 * {@link sendMobileJsonEnvelope}. Returns `true` on success.
 */
export function sendMobileErrorEnvelope(
  ws: Pick<MobileWebSocketLike, 'send'>,
  code: string,
  message: string
): boolean {
  return sendMobileJsonEnvelope(ws, buildMobileErrorEnvelope(code, message))
}

/**
 * Aborts the WebSocket's AbortController if it has one. Swallows errors so a
 * close handler firing after the controller has been disposed cannot throw.
 */
export function abortMobileWebSocket(ws: Pick<MobileWebSocketLike, 'data'>): void {
  try {
    ws.data.abortController.abort()
  } catch {
    // The socket is already closing; abort errors are expected during teardown.
  }
}
