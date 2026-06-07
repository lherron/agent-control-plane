import type {
  DashboardEvent,
  FamilyFilter,
  SessionDashboardSummary,
  SessionTimelineRow,
  StreamConnectionState,
} from '@/features/sessions/types'

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT SEAM (P0). The UI layer (P4/P5) depends ONLY on this signature.
// The real implementation lands in P3 (socket → reducer store → selectors).
// Until then this returns an empty, well-typed snapshot so the UI compiles and
// renders its empty states. Do NOT change the exported shape without coordinating
// — the sessions UI is built against it.
// ─────────────────────────────────────────────────────────────────────────────

export type UseMobileDashboardResult = {
  /** Session rows derived from the live event stream, sorted most-recent-first by the store. */
  rows: SessionTimelineRow[]
  /** Visible events (respecting familyFilter), oldest→newest. */
  events: DashboardEvent[]
  /** Aggregate counts + rates for the StatusStrip. */
  summary: SessionDashboardSummary
  /** Socket connection lifecycle, for the connection badge. */
  connectionState: StreamConnectionState
  /** Currently inspected event (EventInspector), if any. */
  selectedEventId: string | undefined
  /** Currently selected session row, if any. */
  selectedRowId: string | undefined
  /** True when the user paused the live stream. */
  paused: boolean
  /** Active event-family filter ('all' = no filter). */
  familyFilter: FamilyFilter
  /** Pause the live stream (closes socket, freezes view). */
  pause: () => void
  /** Resume the live stream from the last seen cursor. */
  goLive: () => void
  /** Set the event-family filter. */
  setFamilyFilter: (family: FamilyFilter) => void
  /** Select an event for the inspector. */
  selectEvent: (eventId: string) => void
  /** Select a session row. */
  selectRow: (rowId: string) => void
}

const EMPTY_SUMMARY: SessionDashboardSummary = {
  counts: {
    busy: 0,
    idle: 0,
    launching: 0,
    stale: 0,
    dead: 0,
    inFlightInputs: 0,
    deliveryPending: 0,
  },
  eventRatePerMinute: 0,
}

const noop = () => {}

export function useMobileDashboard(): UseMobileDashboardResult {
  // P0 stub — replaced wholesale in P3. Keep the signature stable.
  return {
    rows: [],
    events: [],
    summary: EMPTY_SUMMARY,
    connectionState: 'disconnected',
    selectedEventId: undefined,
    selectedRowId: undefined,
    paused: false,
    familyFilter: 'all',
    pause: noop,
    goLive: noop,
    setFamilyFilter: noop,
    selectEvent: noop,
    selectRow: noop,
  }
}
