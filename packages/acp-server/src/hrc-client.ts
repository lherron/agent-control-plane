/**
 * ACP's HRC client: the pinned hrc-sdk `HrcClient` plus the HRC routes ACP reads that it has no method for yet.
 */
import type { SessionRef } from 'agent-scope'
import { HrcDomainError, resolveControlSocketPath } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
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
} from './hrc-route-reader.js'
import { ACP_SERVER_USER_AGENT } from './user-agent.js'

/** One seat handoff as `GET /v1/seat-handoffs` lists it (max3 HRC 57000d0a, 2026-11-07). */
export type HrcSeatHandoff = {
  id: string
  scopeRef: string
  laneRef: string
  state: string
  createdAt: string
  acknowledgedAt?: string | null | undefined
}

export type ListSeatHandoffsQuery = {
  scopeRef?: string | undefined
  project?: string | undefined
  /** Acknowledged ones too; HRC lists only pending ones otherwise. */
  all?: boolean | undefined
}

/** Independently fenced HRC continuity work register (`/v1/sessions/work`). */
export type SessionWork =
  | { kind: 'none' }
  | { kind: 'task'; taskId: string }
  | { kind: 'workstream'; workstreamId: string }
export type SessionWorkState = { work: SessionWork; workEtag: number }
export type SessionWorkWrite = { scopeRef: string; work: SessionWork; ifMatch: number }

type Params = Record<string, string | number | boolean | readonly string[] | undefined>

function query(params: Params): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === '') continue
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','))
      continue
    }
    search.set(key, String(value))
  }
  const text = search.toString()
  return text.length > 0 ? `?${text}` : ''
}

function eventParams(q: HrcEventSelectors): Params {
  return {
    runId: q.runId,
    hostSessionId: q.hostSessionId,
    scopeRef: q.scopeRef,
    laneRef: q.laneRef,
    generation: q.generation,
    eventKind: q.eventKind,
    liveOnly: q.liveOnly === true ? 'true' : undefined,
  }
}

export class AcpHrcSdkClient extends HrcClient implements HrcRouteReader {
  /** Thread routes use HRC's independently fenced continuity work register. */
  getSessionWork(scopeRef: string): Promise<SessionWorkState> {
    return this.getJson(`/v1/sessions/work?scopeRef=${encodeURIComponent(scopeRef)}&laneRef=main`)
  }

  async putSessionWork(input: SessionWorkWrite, principalRef: string): Promise<SessionWorkState> {
    const response = await this.unixFetch('/v1/sessions/work', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-hrc-principal-ref': principalRef },
      body: JSON.stringify({ ...input, laneRef: 'main' }),
    })
    if (!response.ok) await this.throwTypedError(response)
    return (await response.json()) as SessionWorkState
  }

  /** `GET /v1/seat-handoffs` (T-12715): what `prae seat handoff find` reads. */
  listSeatHandoffs(query: ListSeatHandoffsQuery): Promise<{ handoffs: HrcSeatHandoff[] }> {
    const params = new URLSearchParams()
    if (query.scopeRef !== undefined) params.set('scopeRef', query.scopeRef)
    if (query.project !== undefined) params.set('project', query.project)
    if (query.all === true) params.set('all', 'true')
    return this.getJson(`/v1/seat-handoffs?${params}`)
  }

  async readEvents(q: HrcEventQuery): Promise<HrcEventRow[]> {
    const res = await this.unixFetch(
      `/v1/events${query({
        ...eventParams(q),
        fromSeq: q.fromSeq,
        limit: q.limit,
        fromTs: q.fromTs,
        toTs: q.toTs,
      })}`,
      { method: 'GET' }
    )
    if (!res.ok) await this.throwTypedError(res)
    const text = await res.text()
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HrcEventRow)
  }

  readEventTail(q: HrcEventTailQuery): Promise<HrcEventTail> {
    return this.getJson(
      `/v1/events/tail${query({
        ...eventParams(q),
        limit: q.limit,
        afterSeq: q.afterSeq,
        beforeHrcSeq: q.beforeHrcSeq,
        ledgerIncarnationId: q.ledgerIncarnationId,
      })}`
    )
  }

  readRuns(q: HrcRunQuery): Promise<HrcRunRow[]> {
    return this.getJson(
      `/v1/runs${query({
        runId: q.runId,
        hostSessionId: q.hostSessionId,
        runtimeId: q.runtimeId,
        scopeRef: q.scopeRef,
        laneRef: q.laneRef,
        acceptedSince: q.acceptedSince,
        acceptedBefore: q.acceptedBefore,
        completedSince: q.completedSince,
        open: q.open === true ? 'true' : undefined,
        order: q.order,
        limit: q.limit,
      })}`
    )
  }

  async readRuntimes(q: HrcRuntimeQuery): Promise<HrcRuntimeRow[]> {
    const rows: HrcRuntimeRow[] = []
    let cursor: string | undefined
    do {
      const res = await this.unixFetch(
        `/v1/runtimes${query({
          runtimeId: q.runtimeId,
          hostSessionId: q.hostSessionId,
          scopeRef: q.scopeRef,
          laneRef: q.laneRef,
          transport: q.transport,
          all: q.all === true ? 'true' : undefined,
          limit: 500,
          cursor,
        })}`,
        { method: 'GET' }
      )
      if (!res.ok) await this.throwTypedError(res)
      rows.push(...((await res.json()) as HrcRuntimeRow[]))
      cursor = res.headers.get('x-hrc-next-cursor')?.trim() || undefined
    } while (cursor !== undefined)
    return rows
  }

  async readActiveHostSessionId(sessionRef: SessionRef): Promise<string | undefined> {
    try {
      const session = await this.getJson<{ generation?: { hostSessionId?: unknown } | null }>(
        `/v1/sessions/get${query({ scopeRef: sessionRef.scopeRef, laneRef: sessionRef.laneRef })}`
      )
      const hostSessionId = session.generation?.hostSessionId
      return typeof hostSessionId === 'string' && hostSessionId.length > 0
        ? hostSessionId
        : undefined
    } catch (error) {
      if (error instanceof HrcDomainError && error.code === 'unknown_host_session') return undefined
      throw error
    }
  }
}

/**
 * The deps' HRC route reader, or ACP's HRC client on the control socket.
 * `caller` names the component in HRC's request log.
 */
export function resolveHrcRoutes(
  deps: { hrcRoutes?: HrcRouteReader | undefined },
  caller = 'acp-server'
): HrcRouteReader {
  return (
    deps.hrcRoutes ??
    new AcpHrcSdkClient({
      socketPath: resolveControlSocketPath(),
      userAgent: ACP_SERVER_USER_AGENT,
      caller,
    })
  )
}

/** ACP's HRC client on `socketPath`, or the HRC control socket. */
export function createAcpHrcRouteReader(options: {
  socketPath?: string | undefined
  caller: string
}): AcpHrcSdkClient & { socketPath: string } {
  const socketPath = options.socketPath ?? resolveControlSocketPath()
  return Object.assign(
    new AcpHrcSdkClient({ socketPath, userAgent: ACP_SERVER_USER_AGENT, caller: options.caller }),
    { socketPath }
  )
}
