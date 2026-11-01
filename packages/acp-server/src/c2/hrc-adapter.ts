/**
 * C2Host over the local HRC socket (`deps.hrcClient`), T-12207.
 *
 * Observation is two-speed, because HRC lists annotations per continuity and
 * max3 holds ~150 non-task seats:
 *  - a sweep (`sweepMs`) lists continuities and, every `SCAN_EVERY` sweeps,
 *    the c2 rows of every non-task seat, to learn which seats matter;
 *  - each read (`seats()` / `annotations()`, and the controller host's poll)
 *    fetches attention and c2 rows for just those seats: Vesta, every seat the
 *    scope row allows, and every seat holding c2 rows.
 * Concurrent reads share one in-flight observation; a completed one is never
 * reused, so an action's preflight always sees HRC as it is now.
 *
 * Refusals: an HRC error envelope passes through as `{code, detail}` exactly as
 * HRC spelled it (c2-core never invents one). A socket that cannot be reached
 * at all is a provable pre-dispatch failure: `hrc_unavailable` for writes,
 * `not_submitted` for a send. A literal-input call that does not answer within
 * `literalInputTimeoutMs` THROWS: the call was made, so c2-core records it as
 * `unknown_outcome`, keeps the card locked and never resends.
 */
import { HrcDomainError } from 'hrc-core'

import type {
  AnnotationRow,
  Attention,
  C2Host,
  Expect,
  Key,
  Receipt,
  Refusal,
  SeatRow,
  SendTarget,
} from '@praesidium/c2-core'
import { scopePredicate } from '@praesidium/c2-core'

import type { AcpHrcClient } from '../deps.js'

export type C2HrcClient = Pick<
  AcpHrcClient,
  | 'actOnSessionAnnotation'
  | 'deleteSessionAnnotation'
  | 'deliverLiteralBySelector'
  | 'getSessionAttention'
  | 'getStatus'
  | 'listSessionAnnotations'
  | 'listSessions'
  | 'putSessionAnnotation'
>

export type C2HrcHostOptions = {
  client: C2HrcClient
  vestaSeat: string
  /** The controller's own principal (D9), used when a write names none. */
  principal: string
  node?: string | undefined
  sweepMs: number
  /**
   * Also observe every seat holding c2 rows, outside the scope, so the owner's
   * lifecycle ends narrowed-out cards (D5). Only the production-Vesta instance
   * owns those; any other instance (a fixture) sees just its Vesta and scope.
   */
  ownsUnscoped: boolean
  literalInputTimeoutMs: number
  log(line: string): void
}

export type C2HrcHost = C2Host & {
  /** This node's id: configured, else HRC's declared `status.node.nodeId`. */
  node(): Promise<string>
}

/** Every Nth sweep also lists c2 rows on every non-task seat. */
const SCAN_EVERY = 4
const SCAN_CONCURRENCY = 8
const TASK_SEAT = /:task:T-/

type Observation = { seats: SeatRow[]; annotations: AnnotationRow[] }

function splitSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const match = /^(.*)\/lane:([^/]*)$/.exec(sessionRef)
  return match
    ? { scopeRef: match[1] ?? sessionRef, laneRef: match[2] || 'main' }
    : { scopeRef: sessionRef, laneRef: 'main' }
}

/** Bun's unix-socket connect failures: nothing reached HRC. */
function isUnreachable(error: unknown): boolean {
  if (error instanceof HrcDomainError) return false
  const code = (error as { code?: unknown } | null)?.code
  if (
    typeof code === 'string' &&
    /^(ECONNREFUSED|ENOENT|ECONNRESET_BEFORE_WRITE|FailedToOpenSocket|ConnectionRefused)$/.test(
      code
    )
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ENOENT|FailedToOpenSocket|Unable to connect|ConnectionRefused|No such file/i.test(
    message
  )
}

function refusalOf(error: unknown): Refusal | undefined {
  if (error instanceof HrcDomainError) return { code: error.code, detail: error.detail }
  return undefined
}

function toAttention(a: SessionAttentionWire | null | undefined): Attention | null {
  if (a === null || a === undefined) return null
  return { source: a.source, state: a.state, kind: a.kind, at: a.at, excerpt: a.excerpt ?? null }
}

type SessionAttentionWire = {
  source: string
  state: string
  kind: string
  at: string
  excerpt?: string | null | undefined
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return out
}

export function createC2HrcHost(options: C2HrcHostOptions): C2HrcHost {
  const { client, vestaSeat, log } = options
  const listeners = new Set<() => void>()
  let resolvedNode: string | undefined = options.node
  let continuities: string[] = []
  let rowSeats = new Set<string>()
  let sweeps = 0
  let lastSweepAt = Number.NEGATIVE_INFINITY
  let sweeping: Promise<void> | null = null
  let observing: Promise<Observation> | null = null
  let fingerprint: string | undefined

  async function node(): Promise<string> {
    if (resolvedNode !== undefined) return resolvedNode
    const status = await client.getStatus({ includeSessions: false })
    const declared = (status as { node?: { nodeId?: unknown } }).node?.nodeId
    if (typeof declared !== 'string' || declared.trim() === '') {
      throw new Error('HRC status declares no node id')
    }
    resolvedNode = declared.trim()
    return resolvedNode
  }

  async function c2Rows(scopeRef: string): Promise<AnnotationRow[] | undefined> {
    try {
      const listed = await client.listSessionAnnotations({ scopeRef, laneRef: 'main', ns: 'c2' })
      return listed.annotations as unknown as AnnotationRow[]
    } catch (error) {
      if (error instanceof HrcDomainError && error.code === 'unknown_host_session') return undefined
      throw error
    }
  }

  /** `<seat> <read>` → HRC code already logged as unobservable; cleared by a good read. */
  const unobservable = new Map<string, string>()

  /**
   * One read of a seat this node may not be able to observe (HRC answers e.g.
   * `session_home_pending` for a scope it retired, or
   * `session_home_unreachable`). A refusal skips that read for this pass and
   * is never fatal to the sweep, the tick or the snapshot. Without the live
   * row, c2-core sees the seat as unknown (never moved) and refuses actions
   * `not_submitted` / `seat_unknown`; without the rows, that seat's cards drop
   * out of the view. Only an HRC refusal qualifies: an unreachable socket still
   * fails the whole read. Vesta is never read through here.
   */
  async function readSeat<T>(
    scopeRef: string,
    what: 'attention' | 'annotations',
    read: () => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const key = `${scopeRef} ${what}`
    try {
      const value = await read()
      unobservable.delete(key)
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof HrcDomainError)) throw error
      if (unobservable.get(key) !== error.code) {
        unobservable.set(key, error.code)
        log(`c2.seat.unobservable ${scopeRef} ${what} ${error.code}: skipped until it reads again`)
      }
      return { ok: false }
    }
  }

  async function sweep(): Promise<void> {
    const sessions = await client.listSessions({ latestGeneration: true })
    const scopes = new Set<string>()
    for (const session of sessions) {
      if (session.status === 'archived' || TASK_SEAT.test(session.scopeRef)) continue
      scopes.add(session.scopeRef)
    }
    continuities = [...scopes].sort()
    if (options.ownsUnscoped && sweeps % SCAN_EVERY === 0) {
      const found = new Set<string>()
      await mapLimit(continuities, SCAN_CONCURRENCY, async (scopeRef) => {
        const read = await readSeat(scopeRef, 'annotations', () => c2Rows(scopeRef))
        if (read.ok && read.value !== undefined && read.value.length > 0) found.add(scopeRef)
      })
      rowSeats = found
    }
    sweeps += 1
    lastSweepAt = Date.now()
  }

  async function ensureSwept(): Promise<void> {
    if (Date.now() - lastSweepAt < options.sweepMs) return
    if (sweeping === null) {
      sweeping = sweep().finally(() => {
        sweeping = null
      })
    }
    try {
      await sweeping
    } catch (error) {
      // A failed sweep keeps the previous seat set; with none, the read fails.
      if (sweeps === 0) throw error
      log(`c2: seat sweep failed: ${String(error)}`)
    }
  }

  async function observeSeat(
    scopeRef: string,
    at: string
  ): Promise<{ seat?: SeatRow; rows: AnnotationRow[] }> {
    const readAttention = () =>
      client.getSessionAttention({ scopeRef, laneRef: 'main' }).catch((error: unknown) => {
        if (error instanceof HrcDomainError && error.code === 'unknown_host_session')
          return undefined
        throw error
      })
    let attention: Awaited<ReturnType<typeof readAttention>>
    let rows: AnnotationRow[] | undefined
    if (scopeRef === vestaSeat) {
      ;[attention, rows] = await Promise.all([readAttention(), c2Rows(scopeRef)])
    } else {
      const [live, listed] = await Promise.all([
        readSeat(scopeRef, 'attention', readAttention),
        readSeat(scopeRef, 'annotations', () => c2Rows(scopeRef)),
      ])
      attention = live.ok ? live.value : undefined
      rows = listed.ok ? listed.value : []
    }
    if (options.ownsUnscoped && rows !== undefined && rows.length > 0) rowSeats.add(scopeRef)
    if (attention === undefined) return { rows: rows ?? [] }
    const seat: SeatRow = {
      scopeRef: attention.scopeRef,
      sessionRef: `${attention.scopeRef}/lane:${attention.laneRef || 'main'}`,
      hostSessionId: attention.hostSessionId,
      generation: attention.generation,
      status: attention.runtimeLive ? 'active' : 'inactive',
      // c2-core's `online` needs a runtime marker; HRC's attention route says
      // only whether one is live, which is the one liveness rule (T-12212).
      runtimeId: attention.runtimeLive ? `live:${attention.hostSessionId}` : null,
      attention: toAttention(attention.attention),
      node: at,
    }
    return { seat, rows: rows ?? [] }
  }

  async function observe(): Promise<Observation> {
    await ensureSwept()
    const at = await node()
    const vestaRows = (await c2Rows(vestaSeat)) ?? []
    const scopeRow = vestaRows.find(
      (row) => row.subject === 'seat' && row.kind === 'config' && row.id === 'scope'
    )
    const allow =
      scopeRow !== undefined && Array.isArray((scopeRow.body as { allow?: unknown }).allow)
        ? ((scopeRow.body as { allow: unknown[] }).allow.filter(
            (s) => typeof s === 'string'
          ) as string[])
        : []
    const allowed = scopePredicate(allow)
    const targets = new Set<string>([...rowSeats, ...continuities.filter(allowed)])
    targets.delete(vestaSeat)
    const results = await Promise.all(
      [vestaSeat, ...targets].map((scopeRef) => observeSeat(scopeRef, at))
    )
    const seats: SeatRow[] = []
    const annotations: AnnotationRow[] = []
    for (const result of results) {
      if (result.seat !== undefined) seats.push(result.seat)
      annotations.push(...result.rows)
    }
    const next = JSON.stringify([seats, annotations])
    if (fingerprint !== undefined && next !== fingerprint) {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          log(`c2: change listener failed: ${String(error)}`)
        }
      }
    }
    fingerprint = next
    return { seats, annotations }
  }

  function shared(): Promise<Observation> {
    if (observing === null) {
      observing = observe().finally(() => {
        observing = null
      })
    }
    return observing
  }

  function keyFields(key: Key) {
    const { scopeRef, laneRef } = splitSessionRef(key.sessionRef)
    return {
      scopeRef,
      laneRef,
      subject: key.subject,
      ...(key.generation !== undefined ? { generation: key.generation } : {}),
      ns: key.ns,
      kind: key.kind,
      id: key.id,
    }
  }

  async function write<T>(run: () => Promise<T>): Promise<T | Refusal> {
    try {
      return await run()
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal !== undefined) return refusal
      if (isUnreachable(error))
        return { code: 'hrc_unavailable', detail: { reason: String(error) } }
      throw error
    }
  }

  return {
    node,
    async seats() {
      return (await shared()).seats
    },
    async annotations() {
      return (await shared()).annotations
    },
    put(key: Key, body: object, expect?: Expect, as?: string) {
      return write(async () => {
        const result = await client.putSessionAnnotation(
          {
            ...keyFields(key),
            body: body as Record<string, unknown>,
            ...(expect !== undefined ? { expect } : {}),
          },
          { principalRef: as ?? options.principal }
        )
        return { updatedAt: result.annotation.updatedAt, created: result.created }
      })
    },
    act(key: Key, action: string, attributes: object, as?: string) {
      return write(async () =>
        client.actOnSessionAnnotation(
          { ...keyFields(key), action, attributes: attributes as Record<string, unknown> },
          { principalRef: as ?? options.principal }
        )
      )
    },
    delete(key: Key, expect?: Expect, as?: string) {
      return write(async () =>
        client.deleteSessionAnnotation(
          { ...keyFields(key), ...(expect !== undefined ? { expect } : {}) },
          { principalRef: as ?? options.principal }
        )
      )
    },
    async send(target: SendTarget, text: string): Promise<Receipt | Refusal> {
      // HRC's literal-input route carries no principal; the receipt and the
      // ledger act around it carry `as` (agent:lance for phone actions).
      const call = client.deliverLiteralBySelector({
        selector: { sessionRef: target.sessionRef },
        text,
        enter: true,
        fences: {
          expectedHostSessionId: target.hostSessionId,
          expectedGeneration: target.generation,
        },
      })
      // The call may outlive the deadline; its late settlement is not an error.
      call.catch(() => undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `HRC literal input did not answer within ${options.literalInputTimeoutMs}ms`
              )
            ),
          options.literalInputTimeoutMs
        )
      })
      let delivered: Awaited<typeof call>
      try {
        delivered = await Promise.race([call, deadline])
      } catch (error) {
        const refusal = refusalOf(error)
        if (refusal !== undefined) return refusal
        if (isUnreachable(error))
          return { code: 'not_submitted', detail: { reason: 'hrc_unavailable' } }
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      const receipt: Receipt = {
        node: await node(),
        sessionRef: delivered.sessionRef,
        hostSessionId: delivered.hostSessionId,
        generation: delivered.generation,
        runtimeId: delivered.runtimeId ?? '',
      }
      if (delivered.runId !== undefined) receipt.runId = delivered.runId
      if (delivered.status !== undefined) receipt.status = delivered.status
      return receipt
    },
    onChange(cb: () => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    now: () => new Date().toISOString(),
    log,
  }
}
