/**
 * HRC lifecycle events for `acp task-timeline`, read from HRC's
 * `GET /v1/events` route with the fromTs/toTs window (hrc-runtime T-13244).
 * ACP no longer opens HRC's store (T-13243).
 *
 * HRC ignores a query key it does not know, so the window and the run, scope
 * and lane selectors are re-checked on every row. HRC matches event kinds
 * exactly; a `*` pattern is matched here with the SQL LIKE semantics the store
 * read used (`*` any run, `_` one character, ASCII case-insensitive).
 */
import type { HrcEventRow, HrcEventQuery as HrcRouteEventQuery, HrcRouteReader } from 'acp-server'

export type HrcEvent = {
  hrcSeq: number
  ts: string
  eventKind: string
  eventJson: Record<string, unknown>
  runId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
}

export type HrcEventQuery = {
  hrcRunId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  fromTs: string
  toTs: string
  kinds?: Set<string> | undefined
  allKinds?: boolean | undefined
}

export type HrcEventQueryResult = {
  events: HrcEvent[]
  totalCount: number
}

export type HrcTimelineEventSource = Pick<HrcRouteReader, 'readEvents'>

const ALL_LIMIT = 500
const HEAD_ROWS = 250
const TAIL_ROWS = 100

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapEvent(row: HrcEventRow): HrcEvent {
  return {
    hrcSeq: row.hrcSeq,
    ts: row.ts,
    eventKind: row.eventKind,
    eventJson: asRecord(row.payload),
    ...(row.runId !== undefined ? { runId: row.runId } : {}),
    ...(row.scopeRef !== undefined ? { scopeRef: row.scopeRef } : {}),
    ...(row.laneRef !== undefined ? { laneRef: row.laneRef } : {}),
  }
}

function likePattern(kind: string): RegExp {
  const body = [...kind.replaceAll('*', '%')]
    .map((char) =>
      char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('')
  return new RegExp(`^${body}$`, 'i')
}

function kindFilter(query: HrcEventQuery): {
  wire: string[] | undefined
  matches: (kind: string) => boolean
} {
  if (query.allKinds === true || query.kinds === undefined || query.kinds.size === 0) {
    return { wire: undefined, matches: () => true }
  }
  const exact = [...query.kinds].filter((kind) => !kind.includes('*'))
  const patterns = [...query.kinds].filter((kind) => kind.includes('*')).map(likePattern)
  return {
    // A pattern needs every kind from HRC; exact kinds alone go on the wire.
    wire: patterns.length === 0 ? exact : undefined,
    matches: (kind) => exact.includes(kind) || patterns.some((pattern) => pattern.test(kind)),
  }
}

export class HrcEventReader {
  constructor(private readonly source: HrcTimelineEventSource) {}

  fetchByRunId(query: HrcEventQuery): Promise<HrcEventQueryResult> {
    if (query.hrcRunId === undefined || query.hrcRunId.length === 0) {
      return Promise.resolve({ events: [], totalCount: 0 })
    }
    return this.fetch(query, { runId: query.hrcRunId })
  }

  fetchByScopeWindow(query: HrcEventQuery): Promise<HrcEventQueryResult> {
    if (query.scopeRef === undefined || query.scopeRef.length === 0) {
      return Promise.resolve({ events: [], totalCount: 0 })
    }
    return this.fetch(query, { scopeRef: query.scopeRef, laneRef: query.laneRef ?? 'main' })
  }

  private async fetch(
    query: HrcEventQuery,
    key: { runId: string } | { scopeRef: string; laneRef: string }
  ): Promise<HrcEventQueryResult> {
    const kinds = kindFilter(query)
    const request: HrcRouteEventQuery = {
      ...key,
      fromTs: query.fromTs,
      toTs: query.toTs,
      ...(kinds.wire !== undefined ? { eventKind: kinds.wire } : {}),
    }
    const rows = (await this.source.readEvents(request)).filter(
      (row) =>
        ('runId' in key
          ? row.runId === key.runId
          : row.scopeRef === key.scopeRef && row.laneRef === key.laneRef) &&
        row.ts >= query.fromTs &&
        row.ts <= query.toTs &&
        kinds.matches(row.eventKind)
    )
    const totalCount = rows.length
    const kept =
      totalCount <= ALL_LIMIT ? rows : [...rows.slice(0, HEAD_ROWS), ...rows.slice(-TAIL_ROWS)]
    return { events: kept.map(mapEvent), totalCount }
  }
}
