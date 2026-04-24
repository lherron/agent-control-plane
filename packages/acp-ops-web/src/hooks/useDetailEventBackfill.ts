import type { DashboardEvent, SessionTimelineRow } from 'acp-ops-projection'
import { parseNdjsonChunk } from 'acp-ops-reducer'
import { useEffect, useMemo, useState } from 'react'
import { DETAIL_EVENT_LIMIT, mergeEvents, sortedEvents } from '../lib/events'
import { eventMatchesRow, rowKey } from '../lib/sessionRefs'

const DETAIL_BACKFILL_LOOKBACK = 5_000
const DETAIL_BACKFILL_LIMIT = 500

export function useDetailEventBackfill({
  selectedTimelineRow,
  events,
  replayCursor,
}: {
  selectedTimelineRow?: SessionTimelineRow | undefined
  events: DashboardEvent[]
  replayCursor: number
}) {
  const [detailBackfillByRow, setDetailBackfillByRow] = useState<Record<string, DashboardEvent[]>>(
    {}
  )

  useEffect(() => {
    if (!selectedTimelineRow) return
    if (events.some((event) => eventMatchesRow(event, selectedTimelineRow))) return

    const selectedKey = rowKey(selectedTimelineRow)
    if (detailBackfillByRow[selectedKey] !== undefined) return

    const abortController = new AbortController()
    const fromSeq = Math.max(1, replayCursor - DETAIL_BACKFILL_LOOKBACK)
    const params = new URLSearchParams({
      fromSeq: String(fromSeq),
      follow: 'false',
      hostSessionId: selectedTimelineRow.hostSessionId,
      limit: String(DETAIL_BACKFILL_LIMIT),
    })

    void fetch(`/v1/ops/session-dashboard/events?${params.toString()}`, {
      signal: abortController.signal,
      headers: { Accept: 'application/x-ndjson' },
    })
      .then((response) => (response.ok ? response.text() : ''))
      .then((body) => {
        const parsed = parseNdjsonChunk(body.endsWith('\n') ? body : `${body}\n`)
        setDetailBackfillByRow((current) => {
          if (current[selectedKey] !== undefined) return current
          return {
            ...current,
            [selectedKey]: sortedEvents(parsed.events)
              .filter((event) => eventMatchesRow(event, selectedTimelineRow))
              .slice(-DETAIL_EVENT_LIMIT),
          }
        })
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setDetailBackfillByRow((current) =>
          current[selectedKey] !== undefined ? current : { ...current, [selectedKey]: [] }
        )
      })

    return () => abortController.abort()
  }, [selectedTimelineRow, events, detailBackfillByRow, replayCursor])

  return useMemo(() => {
    if (!selectedTimelineRow) return events
    return mergeEvents(events, detailBackfillByRow[rowKey(selectedTimelineRow)] ?? [])
  }, [events, selectedTimelineRow, detailBackfillByRow])
}
