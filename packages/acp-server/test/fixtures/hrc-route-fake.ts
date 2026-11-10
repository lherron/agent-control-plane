/**
 * A route-backed HRC double for ACP's launcher, sweep, dispatcher and reaper
 * tests (T-13243).
 *
 * It answers HrcRouteReader calls from a fixture SQLite file laid out like the
 * HRC tables the tests already seed (hrc_events, runs, runtimes, continuities;
 * any subset of columns). Rows leave it in the wire shape real calls against
 * max3's HRC returned on 2026-11-10: camelCase, null columns omitted, payload
 * parsed. Selector semantics follow hrc-runtime T-13244 and its acceptance
 * (~/praesidium/var/wrkq-artifacts/T-13244/acceptance.py): inclusive fromTs/toTs
 * and acceptedSince/completedSince, exclusive acceptedBefore and tail afterSeq,
 * tail returns the newest `limit` rows oldest first, runs default to 100 rows by
 * updatedAt DESC.
 *
 * `ignoreNewSelectors: true` behaves like a daemon without T-13244: it drops
 * liveOnly, fromTs/toTs, afterSeq, acceptedSince/acceptedBefore/completedSince,
 * open, order, and runtimeId/scopeRef/laneRef on /v1/runtimes, exactly as an
 * HRC daemon ignores a query key it does not know (EN-50591). `fail` injects a
 * route error such as a 503 session_home_unreachable on scope-keyed reads.
 */
import { Database } from 'bun:sqlite'
import type { SessionRef } from 'agent-scope'
import { HrcDomainError } from 'hrc-core'
import type {
  HrcEventQuery,
  HrcEventRow,
  HrcEventSelectors,
  HrcEventTail,
  HrcEventTailQuery,
  HrcRouteReader,
  HrcRunQuery,
  HrcRunRow,
  HrcRuntimeQuery,
  HrcRuntimeRow,
} from '../../src/hrc-route-reader.js'

export type HrcRouteName = 'events' | 'events.tail' | 'runs' | 'runtimes' | 'sessions.get'

export type HrcRouteCall = { route: HrcRouteName; query: Record<string, unknown> }

export type HrcRouteFakeOptions = {
  ignoreNewSelectors?: boolean | undefined
  fail?: ((call: HrcRouteCall) => Error | undefined) | undefined
}

export type HrcRouteFake = HrcRouteReader & { calls: HrcRouteCall[] }

/** HRC's ten statuses `GET /v1/runtimes` hides without all=true. */
const HIDDEN_RUNTIME_STATUSES = new Set([
  'terminated',
  'stale',
  'crashed',
  'failed',
  'exited',
  'dead',
  'retired',
  'archived',
  'cancelled',
  'completed',
])

/** 503 session_home_unreachable, as a scope-keyed read returns it on a federated node. */
export function sessionHomeUnreachable(): HrcDomainError {
  return new HrcDomainError('session_home_unreachable' as never, 'session home unreachable', {
    retryable: true,
  })
}

type Raw = Record<string, unknown>

function defined<T extends Raw>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null && value !== undefined)
  ) as T
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function createHrcRouteFake(
  fixture: string | Database,
  options: HrcRouteFakeOptions = {}
): HrcRouteFake {
  const calls: HrcRouteCall[] = []
  const strict = options.ignoreNewSelectors !== true

  function withDb<T>(read: (db: Database) => T): T {
    if (typeof fixture !== 'string') return read(fixture)
    const db = new Database(fixture, { readonly: true })
    try {
      return read(db)
    } finally {
      db.close()
    }
  }

  function table(name: string): Raw[] {
    return withDb((db) => {
      const exists = db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        )
        .get(name)
      return exists === null ? [] : (db.query(`SELECT * FROM ${name}`).all() as Raw[])
    })
  }

  function record(route: HrcRouteName, query: object): void {
    const call = { route, query: { ...query } as Record<string, unknown> }
    calls.push(call)
    const error = options.fail?.(call)
    if (error !== undefined) throw error
  }

  function events(): HrcEventRow[] {
    return table('hrc_events')
      .map(
        (r) =>
          defined({
            hrcSeq: r['hrc_seq'] as number,
            ts: r['ts'] as string,
            eventKind: r['event_kind'] as string,
            hostSessionId: r['host_session_id'],
            scopeRef: r['scope_ref'],
            laneRef: r['lane_ref'],
            generation: r['generation'],
            runId: r['run_id'],
            launchId: r['launch_id'],
            evidenceOrigin: r['evidence_origin'],
            payload: parse(r['payload_json']),
          }) as HrcEventRow
      )
      .sort((a, b) => a.hrcSeq - b.hrcSeq)
  }

  function selected(rows: HrcEventRow[], q: HrcEventSelectors): HrcEventRow[] {
    return rows.filter(
      (e) =>
        (q.runId === undefined || e.runId === q.runId) &&
        (q.hostSessionId === undefined || e.hostSessionId === q.hostSessionId) &&
        (q.scopeRef === undefined || e.scopeRef === q.scopeRef) &&
        (q.laneRef === undefined || e.laneRef === q.laneRef) &&
        (q.generation === undefined || e.generation === q.generation) &&
        (q.eventKind === undefined || q.eventKind.includes(e.eventKind)) &&
        (!strict || q.liveOnly !== true || e.evidenceOrigin === undefined)
    )
  }

  return {
    calls,

    async readEvents(q: HrcEventQuery): Promise<HrcEventRow[]> {
      record('events', q)
      const rows = selected(events(), q).filter(
        (e) =>
          (q.fromSeq === undefined || e.hrcSeq >= q.fromSeq) &&
          (!strict || q.fromTs === undefined || e.ts >= q.fromTs) &&
          (!strict || q.toTs === undefined || e.ts <= q.toTs)
      )
      return q.limit === undefined ? rows : rows.slice(0, q.limit)
    },

    async readEventTail(q: HrcEventTailQuery): Promise<HrcEventTail> {
      record('events.tail', q)
      const all = events()
      const rows = selected(all, q).filter(
        (e) =>
          (!strict || q.afterSeq === undefined || e.hrcSeq > q.afterSeq) &&
          (q.beforeHrcSeq === undefined || e.hrcSeq < q.beforeHrcSeq)
      )
      const newest = rows.slice(-q.limit)
      return {
        events: newest,
        headHrcSeq: all.at(-1)?.hrcSeq ?? 0,
        ledgerIncarnationId: 'fixture-ledger',
        truncated: rows.length > q.limit,
      }
    },

    async readRuns(q: HrcRunQuery): Promise<HrcRunRow[]> {
      record('runs', q)
      const rows = table('runs')
        .map(
          (r) =>
            defined({
              runId: r['run_id'] as string,
              status: r['status'] as string,
              hostSessionId: r['host_session_id'],
              runtimeId: r['runtime_id'],
              scopeRef: r['scope_ref'],
              laneRef: r['lane_ref'],
              generation: r['generation'],
              acceptedAt: r['accepted_at'],
              completedAt: r['completed_at'],
              errorCode: r['error_code'],
              errorMessage: r['error_message'],
              updatedAt: r['updated_at'],
            }) as HrcRunRow
        )
        .filter(
          (r) =>
            (q.runId === undefined || r.runId === q.runId) &&
            (q.hostSessionId === undefined || r.hostSessionId === q.hostSessionId) &&
            (q.runtimeId === undefined || r.runtimeId === q.runtimeId) &&
            (q.scopeRef === undefined || r.scopeRef === q.scopeRef) &&
            (q.laneRef === undefined || r.laneRef === q.laneRef) &&
            (!strict ||
              ((q.acceptedSince === undefined ||
                (r.acceptedAt !== undefined && r.acceptedAt >= q.acceptedSince)) &&
                (q.acceptedBefore === undefined ||
                  (r.acceptedAt !== undefined && r.acceptedAt < q.acceptedBefore)) &&
                (q.completedSince === undefined ||
                  (r.completedAt !== undefined && r.completedAt >= q.completedSince)) &&
                (q.open !== true || r.completedAt === undefined)))
        )
      const byCompleted = strict && q.order === 'completedAt'
      rows.sort((a, b) =>
        byCompleted
          ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '') ||
            b.runId.localeCompare(a.runId)
          : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.runId.localeCompare(a.runId)
      )
      return rows.slice(0, q.limit ?? 100)
    },

    async readRuntimes(q: HrcRuntimeQuery): Promise<HrcRuntimeRow[]> {
      record('runtimes', q)
      return table('runtimes')
        .map(
          (r) =>
            defined({
              runtimeId: r['runtime_id'] as string,
              status: r['status'] as string,
              hostSessionId: r['host_session_id'],
              scopeRef: r['scope_ref'],
              laneRef: r['lane_ref'],
              transport: r['transport'],
              updatedAt: r['updated_at'],
              tmuxJson: parse(r['tmux_json']),
            }) as HrcRuntimeRow
        )
        .filter(
          (r) =>
            (q.hostSessionId === undefined || r.hostSessionId === q.hostSessionId) &&
            (q.transport === undefined || r.transport === q.transport) &&
            (q.all === true || !HIDDEN_RUNTIME_STATUSES.has(r.status)) &&
            (!strict ||
              ((q.runtimeId === undefined || r.runtimeId === q.runtimeId) &&
                (q.scopeRef === undefined || r.scopeRef === q.scopeRef) &&
                (q.laneRef === undefined || r.laneRef === q.laneRef)))
        )
    },

    async readActiveHostSessionId(sessionRef: SessionRef): Promise<string | undefined> {
      record('sessions.get', sessionRef)
      const row = table('continuities').find(
        (r) => r['scope_ref'] === sessionRef.scopeRef && r['lane_ref'] === sessionRef.laneRef
      )
      const id = row?.['active_host_session_id']
      return typeof id === 'string' ? id : undefined
    },
  }
}
