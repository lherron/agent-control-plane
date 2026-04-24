import type { DashboardEventFamily } from 'acp-ops-projection'
import { useEffect, useRef, useState } from 'react'
import { createDevelopmentDashboardSnapshot, useSessionDashboardSnapshot } from '../api/snapshot'
import { type StreamSubscription, openSessionDashboardStream } from '../api/stream'
import { dispatchDashboardAction, getDashboardState } from '../store/useReducerStore'

export function useDashboardStream(familyFilter: DashboardEventFamily | 'all') {
  const query = useSessionDashboardSnapshot()
  const [paused, setPaused] = useState(false)
  const streamRef = useRef<StreamSubscription | null>(null)

  useEffect(() => {
    if (query.data) {
      dispatchDashboardAction({ type: 'snapshot.loaded', snapshot: query.data })
    } else if (query.isError && import.meta.env.DEV) {
      dispatchDashboardAction({
        type: 'snapshot.loaded',
        snapshot: createDevelopmentDashboardSnapshot(),
      })
    }
  }, [query.data, query.isError])

  useEffect(() => {
    if (query.isError) {
      dispatchDashboardAction({ type: 'connection.changed', state: 'degraded' })
    }
  }, [query.isError])

  useEffect(() => {
    if (!query.data || paused) return
    const fromSeq = query.data.cursors.nextFromSeq ?? (query.data.cursors.lastHrcSeq ?? 0) + 1
    const stream = openSessionDashboardStream(
      { fromSeq, follow: true, family: familyFilter },
      {
        onEvent: (event) => dispatchDashboardAction({ type: 'event.received', event }),
        onStateChange: (state) => {
          if (!paused) dispatchDashboardAction({ type: 'connection.changed', state })
        },
        onDroppedLines: (count) => dispatchDashboardAction({ type: 'stream.dropped', count }),
        onReconnect: () => dispatchDashboardAction({ type: 'stream.reconnect' }),
        onGap: (requestedFromSeq) =>
          dispatchDashboardAction({ type: 'stream.gap', fromSeq: requestedFromSeq }),
        getLastProcessedHrcSeq: () => getDashboardState().reducer.lastProcessedHrcSeq,
      }
    )
    streamRef.current = stream
    return () => {
      stream.close()
      streamRef.current = null
    }
  }, [query.data, paused, familyFilter])

  const pause = () => {
    setPaused(true)
    streamRef.current?.close()
    dispatchDashboardAction({ type: 'connection.changed', state: 'paused' })
  }

  const goLive = () => {
    setPaused(false)
    dispatchDashboardAction({ type: 'connection.changed', state: 'connected' })
  }

  return { query, paused, pause, goLive }
}
