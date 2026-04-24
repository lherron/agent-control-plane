import type { SessionDashboardSnapshot } from 'acp-ops-projection'

import { json } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  DEFAULT_DASHBOARD_LIMIT_EVENTS,
  DEFAULT_DASHBOARD_LIMIT_SESSIONS,
  DEFAULT_DASHBOARD_WINDOW_MS,
  type DashboardFilters,
  buildDashboardSummary,
  compareDashboardEvents,
  deriveRowsFromEvents,
  eventMatchesFilters,
  parseBoolean,
  parsePositiveInteger,
  projectCoreHrcEvent,
  rowMatchesFilters,
  sessionRecordToRow,
  sortRows,
} from './ops-dashboard-shared.js'

function inWindow(ts: string, fromMs: number, toMs: number): boolean {
  const eventMs = Date.parse(ts)
  return !Number.isFinite(eventMs) || (eventMs >= fromMs && eventMs <= toMs)
}

function rowMatchesStatus(rowStatus: string | undefined, status: string | undefined): boolean {
  if (status === undefined || status === 'all') {
    return true
  }

  if (status === 'active') {
    return rowStatus !== 'removed' && rowStatus !== 'archived'
  }

  return rowStatus === status
}

export const handleOpsDashboardSnapshot: RouteHandler = async ({ url, deps }) => {
  const windowMs = parsePositiveInteger(
    url.searchParams.get('windowMs'),
    DEFAULT_DASHBOARD_WINDOW_MS
  )
  const limitSessions = parsePositiveInteger(
    url.searchParams.get('limitSessions'),
    DEFAULT_DASHBOARD_LIMIT_SESSIONS
  )
  const limitEvents = parsePositiveInteger(
    url.searchParams.get('limitEvents'),
    DEFAULT_DASHBOARD_LIMIT_EVENTS
  )
  const includePrior = parseBoolean(url.searchParams.get('includePrior'), false)
  const status = url.searchParams.get('status') ?? undefined
  const toMs = Date.now()
  const fromMs = toMs - windowMs
  const toTs = new Date(toMs).toISOString()
  const fromTs = new Date(fromMs).toISOString()
  const filters: DashboardFilters = {
    scopeRef: url.searchParams.get('scopeRef') ?? undefined,
    laneRef: url.searchParams.get('laneRef') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
  }

  const hrcClient = deps.hrcClient
  const events = []
  let lastHrcSeq: number | undefined
  let lastStreamSeq: number | undefined

  if (hrcClient !== undefined) {
    for await (const rawEvent of hrcClient.watch({ fromSeq: 1, follow: false })) {
      const event = projectCoreHrcEvent(rawEvent)
      if (event === undefined) {
        continue
      }

      lastHrcSeq = Math.max(lastHrcSeq ?? event.hrcSeq, event.hrcSeq)
      if (event.streamSeq !== undefined) {
        lastStreamSeq = Math.max(lastStreamSeq ?? event.streamSeq, event.streamSeq)
      }

      if (!inWindow(event.ts, fromMs, toMs) || !eventMatchesFilters(event, filters)) {
        continue
      }

      events.push(event)
    }
  }

  const sortedEvents = events.sort(compareDashboardEvents)
  const limitedEvents =
    sortedEvents.length > limitEvents
      ? sortedEvents.slice(sortedEvents.length - limitEvents)
      : sortedEvents
  const rowsById = new Map(
    deriveRowsFromEvents(sortedEvents, windowMs)
      .filter((row) => rowMatchesFilters(row, filters))
      .map((row) => [row.rowId, row])
  )

  if (hrcClient !== undefined) {
    const sessions = await hrcClient.listSessions({
      ...(filters.scopeRef !== undefined ? { scopeRef: filters.scopeRef } : {}),
      ...(filters.laneRef !== undefined ? { laneRef: filters.laneRef } : {}),
    })

    for (const session of sessions) {
      if (!includePrior && session.status === 'prior') {
        continue
      }

      const row = sessionRecordToRow(session)
      if (!rowMatchesFilters(row, filters) || !rowMatchesStatus(row.runtime?.status, status)) {
        continue
      }

      if (!rowsById.has(row.rowId)) {
        rowsById.set(row.rowId, row)
      }
    }
  }

  const sessions = sortRows(
    [...rowsById.values()].filter((row) => rowMatchesStatus(row.runtime?.status, status))
  ).slice(0, limitSessions)
  const summary = buildDashboardSummary(sessions, limitedEvents, windowMs)
  const generatedAt = new Date().toISOString()
  const snapshot: SessionDashboardSnapshot = {
    serverTime: generatedAt,
    generatedAt,
    window: {
      fromTs,
      toTs,
      ...(limitedEvents[0]?.hrcSeq !== undefined ? { fromHrcSeq: limitedEvents[0].hrcSeq } : {}),
      ...(lastHrcSeq !== undefined ? { toHrcSeq: lastHrcSeq } : {}),
    },
    cursors: {
      nextFromSeq: (lastHrcSeq ?? 0) + 1,
      ...(lastHrcSeq !== undefined ? { lastHrcSeq } : {}),
      ...(lastStreamSeq !== undefined ? { lastStreamSeq } : {}),
    },
    summary,
    sessions,
    events: limitedEvents,
  }

  return json(snapshot)
}
