import { json } from '../http.js'
import { mobileUnauthorizedResponse } from '../mobile-auth/gate.js'
import { parseJsonBody, readOptionalTrimmedStringField, requireRecord } from '../parsers/body.js'
import { isLoopbackPeer } from '../routing/peer.js'
import type { RouteHandler } from '../routing/route-context.js'
import { openMobileDashboardWebSocket } from './mobile-dashboard.js'
import { requireHrcClient } from './mobile-hrc.js'
import { openMobileMessagesWebSocket } from './mobile-messages.js'
import { closePluginSubscriptions, handlePluginWebSocketFrame } from './mobile-plugin-ws.js'
import {
  REMOTE_CONTROL_UNAVAILABLE_MESSAGE,
  federatedSessionReadDeclared,
  isRemoteProjectionSource,
} from './mobile-session-access.js'
import { loadMobileSessionPage } from './mobile-session-page.js'
import { openMobileSessionWebSocket } from './mobile-session-stream.js'
import {
  type MobileWebSocketLike,
  abortMobileWebSocket,
  sendMobileErrorEnvelope,
  sendMobileJsonEnvelope,
} from './mobile-ws.js'

const GATEWAY_ID = 'acp-local'
const API_VERSION = 'v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:18470'

type MobileWebSocket = MobileWebSocketLike

export const handleMobileHealth: RouteHandler = async ({ deps }) => {
  const hrcClient = deps.hrcClient
  let hrcOk = false
  let hrcApiVersion: string | undefined = API_VERSION
  let hrcError: string | undefined

  if (hrcClient === undefined) {
    hrcError = 'hrcClient not configured'
  } else {
    try {
      const health = await hrcClient.getHealth()
      hrcOk = health.ok === true
    } catch (error) {
      hrcError = error instanceof Error ? error.message : String(error)
      hrcApiVersion = undefined
    }
  }

  const federatedRead =
    hrcClient !== undefined && hrcOk ? await federatedSessionReadDeclared(hrcClient) : false
  const capabilities = {
    sessions: hrcClient !== undefined,
    timeline: hrcClient !== undefined,
    dashboard: hrcClient !== undefined,
    diagnostics: hrcClient !== undefined,
    input: hrcClient !== undefined,
    interrupt: hrcClient !== undefined,
    pairing: true,
    federationDashboard:
      hrcClient?.listFederationPeerHealth !== undefined &&
      hrcClient.listFederatedRuntimes !== undefined,
    nodeHealth: hrcClient?.listFederationPeerHealth !== undefined,
    remoteRuntimeProjection: hrcClient?.listFederatedRuntimes !== undefined,
    federationSummary:
      hrcClient?.listFederationPeerHealth !== undefined &&
      hrcClient.listFederatedRuntimes !== undefined,
    nodeRuntimeProjection: hrcClient?.listFederatedRuntimes !== undefined,
    semanticDm: hrcClient !== undefined,
    remoteTimeline: federatedRead,
    remoteHistory: federatedRead,
    remoteLiteralInput: false,
    remoteInterrupt: false,
  }

  return json({
    ok: hrcClient !== undefined && hrcOk,
    gatewayId: GATEWAY_ID,
    apiVersion: API_VERSION,
    hrc: {
      ok: hrcOk,
      ...(hrcApiVersion !== undefined ? { apiVersion: hrcApiVersion } : {}),
      ...(hrcError !== undefined ? { error: hrcError } : {}),
      capabilities: {
        sessions: capabilities.sessions,
        events: capabilities.timeline || capabilities.diagnostics,
        dashboard: capabilities.dashboard,
        messages: capabilities.timeline,
        literalInput: capabilities.input,
        appOwnedSessions: false,
      },
    },
    capabilities,
  })
}

export const handleMobileSessionsPage: RouteHandler = async ({ deps, url }) =>
  json(await loadMobileSessionPage(deps, url))

export const handleMobilePairing: RouteHandler = async () =>
  json({
    version: 1,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL: DEFAULT_BASE_URL,
    capabilities: {
      sessions: true,
      timeline: true,
      dashboard: true,
      diagnostics: true,
      input: true,
      interrupt: true,
    },
  })

/**
 * POST /v1/mobile/pair — the token issuance path (spec §1 pair row, §2).
 *
 * The pairing CODE is this route's credential; a bearer is never demanded here,
 * because a device that has not paired has no bearer by definition. Three cases:
 *
 *  - `{ pairingCode }` present: redeemed from ANY peer (loopback included). A
 *    valid code mints a 256-bit token, returned exactly once; only its SHA-256 is
 *    stored. Invalid/expired/replayed → the surface's one 401 shape.
 *  - no code, loopback peer: today's no-op ack, unchanged. It mints nothing.
 *  - no code, non-loopback peer: 401 once enforcement is armed. While `enforce`
 *    is false this still acks, because the dark ship is zero behavior change and
 *    the shipped iOS client pairs with no code today.
 */
export const handleMobilePair: RouteHandler = async ({ request, deps, peer }) => {
  const body = requireRecord(await parseJsonBody(request))
  const baseURL = readOptionalTrimmedStringField(body, 'baseURL') ?? DEFAULT_BASE_URL
  const pairingCode = readOptionalTrimmedStringField(body, 'pairingCode')
  const deviceName = readOptionalTrimmedStringField(body, 'deviceName')
  const store = deps.mobileAuthStore

  const ack = {
    ok: true,
    gatewayId: GATEWAY_ID,
    displayName: 'Local ACP',
    baseURL,
    pairedAt: new Date().toISOString(),
  }

  if (pairingCode !== undefined && pairingCode.length > 0) {
    const redeemed = store.redeemPairingCode(pairingCode, deviceName)
    if (redeemed === undefined) {
      return mobileUnauthorizedResponse()
    }
    return json({
      ...ack,
      pairedAt: redeemed.device.pairedAt,
      deviceId: redeemed.device.deviceId,
      // Returned once and never again: the server keeps only the hash.
      token: redeemed.token,
    })
  }

  if (store.isEnforcing() && !isLoopbackPeer(peer)) {
    return mobileUnauthorizedResponse()
  }

  return json(ack)
}

export async function openMobileWebSocket(ws: MobileWebSocket): Promise<void> {
  const { deps, url, kind, hostSessionId: pathHostSessionId } = ws.data
  const hrcClient = requireHrcClient(deps)
  const parsedURL = new URL(url)

  const remoteSource = isRemoteProjectionSource(parsedURL.searchParams.get('sourceKind'))
  const requestedSessionRef = parsedURL.searchParams.get('sessionRef')?.trim() || undefined
  if (
    remoteSource &&
    (kind === 'diagnostics' ||
      (kind === 'timeline' && !(await federatedSessionReadDeclared(hrcClient))))
  ) {
    sendMobileErrorEnvelope(ws, 'remote_control_unavailable', REMOTE_CONTROL_UNAVAILABLE_MESSAGE)
    ws.close(1008, 'remote control unavailable')
    return
  }
  if (remoteSource && kind === 'timeline' && requestedSessionRef === undefined) {
    // T-10418 §5.3: a remote timeline names its scope; the home is found by it.
    sendMobileErrorEnvelope(ws, 'session_ref_required', 'remote timeline requires sessionRef')
    ws.close(1008, 'sessionRef required')
    return
  }

  if (kind === 'messages') {
    await openMobileMessagesWebSocket(ws, parsedURL)
    return
  }

  if (kind === 'dashboard') {
    await openMobileDashboardWebSocket(ws, hrcClient, parsedURL, GATEWAY_ID)
    return
  }

  if (pathHostSessionId === undefined || pathHostSessionId.length === 0) {
    sendMobileErrorEnvelope(ws, 'invalid_path', 'hostSessionId path segment is required')
    ws.close(1008, 'missing hostSessionId')
    return
  }

  await openMobileSessionWebSocket(ws, hrcClient, parsedURL, pathHostSessionId, requestedSessionRef)
}

export function closeMobileWebSocket(ws: MobileWebSocket): void {
  abortMobileWebSocket(ws)
  closePluginSubscriptions(ws)
}

export function handleMobileWebSocketMessage(ws: MobileWebSocket, message: string | Buffer): void {
  if (ws.data.kind !== 'dashboard') return
  const text = typeof message === 'string' ? message : message.toString('utf8')
  try {
    const parsed = JSON.parse(text) as { type?: unknown; id?: unknown }
    // Plugin-page subscriptions multiplex on this socket (features/mobile-plugin-pages.md).
    if (handlePluginWebSocketFrame(ws, parsed)) return
    if (parsed.type === 'ping') {
      sendMobileJsonEnvelope(ws, {
        type: 'pong',
        ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
        ts: new Date().toISOString(),
      })
    }
  } catch {
    if (text.trim() === 'ping') {
      sendMobileJsonEnvelope(ws, { type: 'pong', ts: new Date().toISOString() })
    }
  }
}
