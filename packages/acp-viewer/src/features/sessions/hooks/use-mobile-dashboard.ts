import { useCallback, useEffect, useRef, useState } from 'react'
import { openMobileDashboardSocket } from '@/features/sessions/api/mobile-socket'
import type { MobileSocketSubscription } from '@/features/sessions/api/mobile-socket'
import {
  mobileEventToDashboardEvent,
  mobileSnapshotToDashboardSnapshot,
} from '@/features/sessions/lib/mobile-adapter'
import {
  dispatchDashboardAction,
  getDashboardState,
  useReducerStore,
} from '@/features/sessions/store/use-reducer-store'
import type {
  DashboardEvent,
  FamilyFilter,
  SessionDashboardSummary,
  SessionTimelineRow,
  StreamConnectionState,
} from '@/features/sessions/types'

// ─────────────────────────────────────────────────────────────────────────────
// Live hrc dashboard, fed by the /v1/mobile/dashboard WS. Opens the socket,
// adapts mobile frames into the shared projection contracts, and dispatches into
// the ported reducer store. Exposes paused/pause/goLive + family filter +
// selection. Signature is the P0 contract the sessions UI is built against.
// ─────────────────────────────────────────────────────────────────────────────

export type UseMobileDashboardResult = {
  rows: SessionTimelineRow[]
  events: DashboardEvent[]
  summary: SessionDashboardSummary
  connectionState: StreamConnectionState
  selectedEventId: string | undefined
  selectedRowId: string | undefined
  paused: boolean
  familyFilter: FamilyFilter
  pause: () => void
  goLive: () => void
  setFamilyFilter: (family: FamilyFilter) => void
  selectEvent: (eventId: string) => void
  selectRow: (rowId: string) => void
}

export function useMobileDashboard(): UseMobileDashboardResult {
  const rows = useReducerStore((s) => s.rows)
  const events = useReducerStore((s) => s.events)
  const summary = useReducerStore((s) => s.summary)
  const connectionState = useReducerStore((s) => s.connectionState)
  const selectedEventId = useReducerStore((s) => s.selectedEventId)
  const selectedRowId = useReducerStore((s) => s.selectedRowId)
  const familyFilter = useReducerStore((s) => s.familyFilter)

  const [paused, setPaused] = useState(false)
  const socketRef = useRef<MobileSocketSubscription | null>(null)

  useEffect(() => {
    if (paused) return

    // Resume from the last seen cursor across remounts/pauses; undefined on a
    // cold start pulls a fresh snapshot.
    const last = getDashboardState().reducer.lastProcessedHrcSeq
    const fromHrcSeq = last > 0 ? last + 1 : undefined

    const socket = openMobileDashboardSocket(
      { fromHrcSeq },
      {
        onSnapshot: (frame) =>
          dispatchDashboardAction({
            type: 'snapshot.loaded',
            snapshot: mobileSnapshotToDashboardSnapshot(frame),
          }),
        onEvent: (message) => {
          const event = mobileEventToDashboardEvent(message)
          if (event !== undefined) dispatchDashboardAction({ type: 'event.received', event })
        },
        onState: (state) => {
          if (!paused) dispatchDashboardAction({ type: 'connection.changed', state })
        },
        onGap: () => {
          dispatchDashboardAction({ type: 'stream.gap', fromSeq: 0 })
          dispatchDashboardAction({ type: 'stream.reconnect' })
        },
      }
    )
    socketRef.current = socket
    return () => {
      socket.close()
      socketRef.current = null
    }
  }, [paused])

  const pause = useCallback(() => {
    setPaused(true)
    socketRef.current?.close()
    socketRef.current = null
    dispatchDashboardAction({ type: 'connection.changed', state: 'paused' })
  }, [])

  const goLive = useCallback(() => {
    setPaused(false)
    dispatchDashboardAction({ type: 'connection.changed', state: 'connected' })
  }, [])

  const setFamilyFilter = useCallback((family: FamilyFilter) => {
    dispatchDashboardAction({ type: 'filter.family', family })
  }, [])

  const selectEvent = useCallback((eventId: string) => {
    dispatchDashboardAction({ type: 'event.selected', eventId })
  }, [])

  const selectRow = useCallback((rowId: string) => {
    dispatchDashboardAction({ type: 'row.selected', rowId })
  }, [])

  return {
    rows,
    events,
    summary,
    connectionState,
    selectedEventId,
    selectedRowId,
    paused,
    familyFilter,
    pause,
    goLive,
    setFamilyFilter,
    selectEvent,
    selectRow,
  }
}
