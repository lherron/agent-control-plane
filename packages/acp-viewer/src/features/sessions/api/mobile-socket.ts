import type { StreamConnectionState } from '@/features/sessions/types'
import type {
  MobileDashboardSnapshotFrame,
  MobileEventMessage,
  MobileFrame,
  MobileSessionSummary,
} from '@/features/sessions/lib/mobile-frames'

export type MobileSocketOptions = {
  /** Resume cursor: subscribe from this hrcSeq. Omit for a fresh snapshot. */
  fromHrcSeq?: number | undefined
  /** How many recent events per session the snapshot should carry. */
  recentEventsPerSession?: number | undefined
}

export type MobileSocketHandlers = {
  onSnapshot?: ((frame: MobileDashboardSnapshotFrame) => void) | undefined
  onEvent?: ((message: MobileEventMessage) => void) | undefined
  /** Per-session roster update (live status/runtime changes). */
  onSessionUpdate?: ((session: MobileSessionSummary) => void) | undefined
  onState?: ((state: StreamConnectionState) => void) | undefined
  /** Replay cursor too old — caller should treat next snapshot as a reset. */
  onGap?: (() => void) | undefined
  onPing?: (() => void) | undefined
}

export type MobileSocketSubscription = {
  close: () => void
}

const BASE_RECONNECT_MS = 400
const MAX_RECONNECT_MS = 8_000
const DEFAULT_RECENT_PER_SESSION = 25

function dashboardUrl(fromHrcSeq: number | undefined, recentPerSession: number): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const params = new URLSearchParams()
  params.set('recentEventsPerSession', String(recentPerSession))
  if (fromHrcSeq !== undefined) params.set('fromHrcSeq', String(fromHrcSeq))
  return `${scheme}://${window.location.host}/v1/mobile/dashboard?${params.toString()}`
}

/**
 * Open a managed connection to the mobile dashboard WS. Parses frames and routes
 * them to typed callbacks, reconnects with capped backoff, resubscribes from the
 * last seen hrcSeq, and on a replay_gap_too_large error drops the cursor to pull a
 * fresh snapshot. Duplicate events (by hrcSeq) are filtered before onEvent.
 */
export function openMobileDashboardSocket(
  options: MobileSocketOptions,
  handlers: MobileSocketHandlers = {}
): MobileSocketSubscription {
  const recentPerSession = options.recentEventsPerSession ?? DEFAULT_RECENT_PER_SESSION
  let closed = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  // Resume cursor; advances as events stream in. undefined → request fresh snapshot.
  let cursor = options.fromHrcSeq
  let lastSeenHrcSeq = cursor !== undefined ? cursor - 1 : -1

  const setState = (state: StreamConnectionState) => {
    if (!closed) handlers.onState?.(state)
  }

  const scheduleReconnect = () => {
    if (closed) return
    setState('reconnecting')
    const delay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** attempt)
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  const handleFrame = (frame: MobileFrame) => {
    switch (frame.type) {
      case 'dashboard_snapshot': {
        lastSeenHrcSeq = Math.max(lastSeenHrcSeq, frame.cursors.lastHrcSeq)
        cursor = frame.cursors.nextFromHrcSeq
        setState('connected')
        handlers.onSnapshot?.(frame)
        return
      }
      case 'hrc_event': {
        if (frame.hrcSeq <= lastSeenHrcSeq) return // duplicate / replay overlap
        lastSeenHrcSeq = frame.hrcSeq
        cursor = frame.hrcSeq + 1
        handlers.onEvent?.(frame)
        return
      }
      case 'session_updated':
        handlers.onSessionUpdate?.(frame.session)
        return
      case 'ping':
        handlers.onPing?.()
        return
      case 'error': {
        if (frame.code === 'replay_gap_too_large') {
          cursor = undefined // resubscribe fresh
          lastSeenHrcSeq = -1
          setState('degraded')
          handlers.onGap?.()
        }
        return
      }
      // sessions_refreshed ignored — its roster equals the snapshot's, sent once at connect
      default:
        return
    }
  }

  const connect = () => {
    if (closed) return
    setState(cursor !== undefined && lastSeenHrcSeq >= 0 ? 'replaying' : 'connected')
    const ws = new WebSocket(dashboardUrl(cursor, recentPerSession))
    socket = ws

    ws.onopen = () => {
      attempt = 0
    }
    ws.onmessage = (event) => {
      let frame: MobileFrame
      try {
        frame = JSON.parse(String(event.data)) as MobileFrame
      } catch {
        return
      }
      handleFrame(frame)
    }
    ws.onclose = () => {
      if (closed) return
      socket = null
      scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose fires after onerror; let it drive the reconnect.
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  connect()

  return {
    close() {
      closed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      if (socket !== null) {
        try {
          socket.close()
        } catch {
          /* ignore */
        }
        socket = null
      }
      handlers.onState?.('disconnected')
    },
  }
}
