import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

export const DEFAULT_HRC_STORE_PATH = '/Users/lherron/praesidium/var/state/hrc/state.sqlite'

export const DEFAULT_HRC_KINDS_EXCLUDED = new Set([
  'codex.websocket_event',
  'codex.sse_event',
  'codex.websocket_request',
  'codex.websocket_connect',
  'message_start',
  'message_update',
  'tool_execution_update',
])

export type HrcStoreTable = 'events' | 'hrc_events'

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

type RawHrcEventRow = {
  hrcSeq: number
  ts: string
  eventKind: string
  eventJson: string
  runId: string | null
  scopeRef: string | null
  laneRef: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseEventJson(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return { raw }
  }
}

function mapEventRow(row: RawHrcEventRow): HrcEvent {
  return {
    hrcSeq: row.hrcSeq,
    ts: row.ts,
    eventKind: row.eventKind,
    eventJson: parseEventJson(row.eventJson),
    ...(row.runId !== null ? { runId: row.runId } : {}),
    ...(row.scopeRef !== null ? { scopeRef: row.scopeRef } : {}),
    ...(row.laneRef !== null ? { laneRef: row.laneRef } : {}),
  }
}

export function resolveHrcStorePath(
  explicitPath: string | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    return explicitPath.trim()
  }
  const stateDir = env['HRC_STATE_DIR']
  if (stateDir !== undefined && stateDir.trim().length > 0) {
    return join(stateDir, 'state.sqlite')
  }
  return DEFAULT_HRC_STORE_PATH
}

function tableExists(db: Database, table: HrcStoreTable): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(table)
  return row !== null
}

function resolveTable(db: Database): HrcStoreTable | undefined {
  if (tableExists(db, 'events')) return 'events'
  if (tableExists(db, 'hrc_events')) return 'hrc_events'
  return undefined
}

function selectColumns(table: HrcStoreTable): string {
  if (table === 'events') {
    return `
      seq AS hrcSeq,
      ts AS ts,
      event_kind AS eventKind,
      event_json AS eventJson,
      run_id AS runId,
      scope_ref AS scopeRef,
      lane_ref AS laneRef`
  }
  return `
    hrc_seq AS hrcSeq,
    ts AS ts,
    event_kind AS eventKind,
    payload_json AS eventJson,
    run_id AS runId,
    scope_ref AS scopeRef,
    lane_ref AS laneRef`
}

function seqColumn(table: HrcStoreTable): string {
  return table === 'events' ? 'seq' : 'hrc_seq'
}

function buildWhere(
  query: HrcEventQuery,
  mode: 'run_id' | 'scope_window'
): { whereSql: string; bindings: Array<string | number> } {
  const where: string[] = ['ts >= ?', 'ts <= ?']
  const bindings: Array<string | number> = [query.fromTs, query.toTs]

  if (mode === 'run_id') {
    where.unshift('run_id = ?')
    bindings.unshift(query.hrcRunId ?? '')
  } else {
    where.unshift('scope_ref = ?', 'lane_ref = ?')
    bindings.unshift(query.scopeRef ?? '', query.laneRef ?? 'main')
  }

  if (query.allKinds !== true) {
    if (query.kinds !== undefined && query.kinds.size > 0) {
      const exactKinds = [...query.kinds].filter((kind) => !kind.includes('*'))
      const wildcardKinds = [...query.kinds].filter((kind) => kind.includes('*'))
      const kindClauses: string[] = []
      if (exactKinds.length > 0) {
        kindClauses.push(`event_kind IN (${exactKinds.map(() => '?').join(', ')})`)
        bindings.push(...exactKinds)
      }
      for (const kind of wildcardKinds) {
        kindClauses.push('event_kind LIKE ?')
        bindings.push(kind.replaceAll('*', '%'))
      }
      where.push(`(${kindClauses.join(' OR ')})`)
    } else {
      where.push(`event_kind NOT IN (${[...DEFAULT_HRC_KINDS_EXCLUDED].map(() => '?').join(', ')})`)
      bindings.push(...DEFAULT_HRC_KINDS_EXCLUDED)
    }
  }

  return { whereSql: where.join(' AND '), bindings }
}

function emptyResult(): HrcEventQueryResult {
  return { events: [], totalCount: 0 }
}

export class HrcStoreReader {
  readonly path: string

  private readonly db: Database
  private readonly table: HrcStoreTable

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(`HRC store does not exist: ${path}`)
    }
    this.path = path
    this.db = new Database(path, { readonly: true })
    const table = resolveTable(this.db)
    if (table === undefined) {
      this.db.close()
      throw new Error(`HRC store has no events table: ${path}`)
    }
    this.table = table
  }

  close(): void {
    this.db.close()
  }

  fetchByRunId(query: HrcEventQuery): HrcEventQueryResult {
    if (query.hrcRunId === undefined || query.hrcRunId.length === 0) {
      return emptyResult()
    }
    return this.fetch(query, 'run_id')
  }

  fetchByScopeWindow(query: HrcEventQuery): HrcEventQueryResult {
    if (query.scopeRef === undefined || query.scopeRef.length === 0) {
      return emptyResult()
    }
    return this.fetch(query, 'scope_window')
  }

  private fetch(query: HrcEventQuery, mode: 'run_id' | 'scope_window'): HrcEventQueryResult {
    const { whereSql, bindings } = buildWhere(query, mode)
    const totalRow = this.db
      .query<{ total: number }, Array<string | number>>(
        `SELECT COUNT(*) AS total FROM ${this.table} WHERE ${whereSql}`
      )
      .get(...bindings)
    const totalCount = totalRow?.total ?? 0
    if (totalCount === 0) return emptyResult()

    const columns = selectColumns(this.table)
    const seq = seqColumn(this.table)
    if (totalCount <= 500) {
      const rows = this.db
        .query<RawHrcEventRow, Array<string | number>>(
          `SELECT ${columns} FROM ${this.table} WHERE ${whereSql} ORDER BY ${seq} ASC`
        )
        .all(...bindings)
      return { events: rows.map(mapEventRow), totalCount }
    }

    const firstRows = this.db
      .query<RawHrcEventRow, Array<string | number>>(
        `SELECT ${columns} FROM ${this.table} WHERE ${whereSql} ORDER BY ${seq} ASC LIMIT 250`
      )
      .all(...bindings)
    const lastRows = this.db
      .query<RawHrcEventRow, Array<string | number>>(
        `SELECT ${columns} FROM ${this.table} WHERE ${whereSql} ORDER BY ${seq} DESC LIMIT 100`
      )
      .all(...bindings)
      .reverse()

    return {
      events: [...firstRows, ...lastRows].map(mapEventRow),
      totalCount,
    }
  }
}
