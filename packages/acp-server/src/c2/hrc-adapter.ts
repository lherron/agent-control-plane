/**
 * C2Host over the local HRC socket (`deps.hrcClient`), T-12207.
 *
 * Observation is two-speed, because HRC lists annotations per continuity and
 * max3 holds ~150 non-task seats:
 *  - a sweep (`sweepMs`) lists continuities and, every `SCAN_EVERY` sweeps,
 *    the c2 rows of every non-task seat, to learn which seats matter;
 *  - each read (`seats()` / `annotations()`, and the controller host's poll)
 *    covers attention, c2 rows and the `hrc.asks` record for just those
 *    seats: Vesta, every seat the scope row allows, and every seat holding c2
 *    rows (card contract rev 4 §3).
 * One annotation list supplies both namespaces, including Vesta's scope row;
 * at most eight seats are observed concurrently (two reads per seat).
 *
 * Reads are dirty-driven (T-12421). One long-lived HRC event follow stream
 * (`GET /v1/events?follow=true`) marks each event's `scopeRef` dirty and, for a
 * watched seat, tells `onDirty` listeners (the controller host starts a read); every
 * annotation put/delete/act appends a session event, so asks and c2 row
 * changes arrive the same way. A read re-reads only dirty watched seats (and a
 * watched seat never read yet) and serves every other seat from its last
 * observation. A seat not read for `fullRefreshMs` is re-read anyway, a few
 * oldest per read (`AGED_PER_PASS`), which bounds any staleness from an event
 * this host missed without one long pass that a dirty read would queue behind
 * on a loaded HRC. While the stream is down (not yet
 * connected, refused, ended) every read is a full read, never staler than a
 * poll; it reconnects with backoff from the last seen `hrcSeq`.
 *
 * Concurrent reads share one in-flight observation, and a completed one is
 * never reused. A write through this host, or `freshen()` (an action's
 * preflight: the acted seat and Vesta), marks those seats dirty and refuses to
 * join an observation that started earlier, so the next read sees HRC as it is
 * now for every seat the action touches.
 *
 * Refusals: an HRC error envelope passes through as `{code, detail}` exactly as
 * HRC spelled it (c2-core never invents one). A socket that cannot be reached
 * at all is a provable pre-dispatch failure: `hrc_unavailable` for writes,
 * `not_submitted` for a send. A literal-input call that does not answer within
 * `literalInputTimeoutMs` THROWS: the call was made, so c2-core records it as
 * `unknown_outcome`, keeps the card locked and never resends.
 *
 * End causes (T-12233): `runtimeEnd` answers from HRC's runtime record for the
 * card's host session (`GET /v1/runtimes?hostSessionId=…&all=true`, one cheap
 * indexed read; the reason is `runtimeStateJson.terminationReason`, e.g.
 * `user_initiated_session_end`). The ledger's `runtime.terminated` event carries
 * the same reason but its tail read is far slower on a loaded HRC. A generation
 * with any non-terminal runtime is not ended; no record is "not confirmed".
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
  | 'listRuntimes'
  | 'listSessionAnnotations'
  | 'listSessions'
  | 'putSessionAnnotation'
  | 'tailEvents'
  | 'watch'
>

export type C2HrcHostOptions = {
  client: C2HrcClient
  vestaSeat: string
  /** The controller's own principal (D9), used when a write names none. */
  principal: string
  node?: string | undefined
  sweepMs: number
  /** Safety-net cadence: re-read every watched seat even with no event for it. */
  fullRefreshMs: number
  /**
   * Also observe every seat holding c2 rows, outside the scope, so the owner's
   * lifecycle ends narrowed-out cards (D5). Only the production-Vesta instance
   * owns those; any other instance (a fixture) sees just its Vesta and scope.
   */
  ownsUnscoped: boolean
  literalInputTimeoutMs: number
  /** Handoff lookup (T-12233 §4); absent means the rotated wake reads `handoff=unknown`. */
  handoffSince?: ((scopeRef: string, sinceIso: string) => Promise<boolean | null>) | undefined
  log(line: string): void
}

export type C2HrcHost = C2Host & {
  /** This node's id: configured, else HRC's declared `status.node.nodeId`. */
  node(): Promise<string>
  /** The next read re-reads these seats from HRC and joins no earlier observation. */
  freshen(scopeRefs: readonly string[]): void
  /**
   * Called when an HRC event marks a watched seat dirty, so the caller can
   * start a read now rather than on its next poll (T-12421 amendment b).
   */
  onDirty(cb: () => void): () => void
  /** Stop the event follower. */
  close(): void
}

/** Every Nth sweep also lists c2 rows on every non-task seat. */
const SCAN_EVERY = 4
const SCAN_CONCURRENCY = 8
const TASK_SEAT = /:task:T-/
/** Only a recorded termination confirms an end; any other status may be a liveness blip (the hold). */
const TERMINATED = 'terminated'
/** Event-follower reconnect backoff bounds. */
const FOLLOW_BACKOFF_MIN_MS = 500
const FOLLOW_BACKOFF_MAX_MS = 30_000

type Observation = { seats: SeatRow[]; annotations: AnnotationRow[] }
/**
 * The safety net's per-read budget: at most this many seats re-read only for
 * age, oldest first (one concurrency round of two reads each), so it never
 * holds up a dirty seat's read behind a pass over every seat.
 */
const AGED_PER_PASS = SCAN_CONCURRENCY / 2

/** One seat's last read: its live row (absent when unobservable or unknown) and its rows. */
type SeatObservation = { seat?: SeatRow; rows: AnnotationRow[]; readAt: number }

export function splitSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
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
  const dirtyListeners = new Set<() => void>()
  /** Vesta and every target of the last completed pass. */
  let watchedSeats = new Set<string>()
  let resolvedNode: string | undefined = options.node
  let continuities: string[] = []
  let rowSeats = new Set<string>()
  let sweeps = 0
  let lastSweepAt = Number.NEGATIVE_INFINITY
  let sweeping: Promise<void> | null = null
  let observing: { promise: Promise<Observation>; epoch: number } | null = null
  let fingerprint: string | undefined
  /** Last observation of each watched seat (Vesta included). */
  const cache = new Map<string, SeatObservation>()
  /** Seats an event (or a write) touched since they were last read. */
  const dirty = new Set<string>()
  /** The next read re-reads every watched seat. */
  let allDirty = true
  /** Bumped by every write and `freshen`; an observation started under an older epoch is not joined. */
  let epoch = 0
  /** The follow stream is running from a known cursor; false means every read is a full read. */
  let following = false
  let lastSeq: number | undefined
  let closed = false
  const followAbort = new AbortController()
  /** `<sessionRef>#<generation>` → that generation's host session, from observed c2 rows and seats. */
  const hostSessions = new Map<string, string>()

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
      return listed.annotations
    } catch (error) {
      if (error instanceof HrcDomainError && error.code === 'unknown_host_session') return undefined
      throw error
    }
  }

  /** c2's rows plus the seat's `hrc.asks` record (card contract rev 4 §3). */
  async function seatRows(scopeRef: string): Promise<AnnotationRow[] | undefined> {
    try {
      const { annotations } = await client.listSessionAnnotations({ scopeRef, laneRef: 'main' })
      return annotations.filter(
        (row) =>
          row.ns === 'c2' || (row.ns === 'hrc' && row.subject === 'seat' && row.kind === 'asks')
      )
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
    // A failed sweep keeps the previous seat set; with none, the read fails.
    const settled = sweeping.catch((error: unknown) => {
      if (sweeps === 0) throw error
      log(`c2: seat sweep failed: ${String(error)}`)
    })
    // Only the first sweep is waited on: a later one (its every-SCAN_EVERY scan
    // lists ~150 seats) runs behind the reads, which keep the previous seat set.
    if (sweeps === 0) await settled
  }

  async function observeSeat(
    scopeRef: string,
    at: string,
    listedRows?: AnnotationRow[]
  ): Promise<Omit<SeatObservation, 'readAt'>> {
    const readAttention = () =>
      client.getSessionAttention({ scopeRef, laneRef: 'main' }).catch((error: unknown) => {
        if (error instanceof HrcDomainError && error.code === 'unknown_host_session')
          return undefined
        throw error
      })
    let attention: Awaited<ReturnType<typeof readAttention>>
    let rows: AnnotationRow[] | undefined
    if (scopeRef === vestaSeat) {
      ;[attention, rows] = await Promise.all([
        readAttention(),
        listedRows === undefined ? seatRows(scopeRef) : Promise.resolve(listedRows),
      ])
    } else {
      const [live, listed] = await Promise.all([
        readSeat(scopeRef, 'attention', readAttention),
        readSeat(scopeRef, 'annotations', () => seatRows(scopeRef)),
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

  function freshen(scopeRefs: readonly string[]): void {
    for (const scopeRef of scopeRefs) dirty.add(scopeRef)
    epoch += 1
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      ;(timer as { unref?: () => void }).unref?.()
      followAbort.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  /**
   * The one event follower: marks each event's seat dirty. Down is logged once
   * per outage; reads stay full until it is following again.
   */
  async function follow(): Promise<void> {
    let backoff = FOLLOW_BACKOFF_MIN_MS
    let downLogged = false
    while (!closed) {
      try {
        const fromSeq =
          lastSeq !== undefined
            ? lastSeq + 1
            : (await client.tailEvents({ limit: 1 })).headHrcSeq + 1
        // From here no event is lost: the stream replays from `fromSeq`. The
        // first read after a (re)connect is full, covering the outage.
        following = true
        allDirty = true
        log(`c2.follow.connected fromSeq=${fromSeq}`)
        downLogged = false
        for await (const event of client.watch({
          follow: true,
          fromSeq,
          signal: followAbort.signal,
        })) {
          lastSeq = event.hrcSeq
          dirty.add(event.scopeRef)
          backoff = FOLLOW_BACKOFF_MIN_MS
          if (watchedSeats.has(event.scopeRef)) {
            for (const listener of dirtyListeners) {
              try {
                listener()
              } catch (error) {
                log(`c2: dirty listener failed: ${String(error)}`)
              }
            }
          }
        }
        if (closed) return
        throw new Error('event stream ended')
      } catch (error) {
        if (closed) return
        following = false
        if (!downLogged) {
          log(`c2.follow.down ${String(error)}: full reads until it reconnects`)
          downLogged = true
        }
        await sleep(backoff)
        backoff = Math.min(backoff * 2, FOLLOW_BACKOFF_MAX_MS)
      }
    }
  }
  let followerStarted = false

  async function observe(): Promise<Observation> {
    if (!followerStarted) {
      followerStarted = true
      void follow()
    }
    await ensureSwept()
    const at = await node()
    const startedAt = Date.now()
    const full = !following || allDirty
    // Take this pass's dirty set; an event landing during the read marks the next pass.
    const taken = new Set(dirty)
    dirty.clear()
    if (full) allDirty = false
    const due = (scopeRef: string) => full || taken.has(scopeRef) || !cache.has(scopeRef)
    const ageOf = (scopeRef: string) => startedAt - (cache.get(scopeRef)?.readAt ?? startedAt)
    try {
      const readVesta = due(vestaSeat) || ageOf(vestaSeat) >= options.fullRefreshMs
      const vestaRows = readVesta
        ? ((await seatRows(vestaSeat)) ?? [])
        : (cache.get(vestaSeat)?.rows ?? [])
      const scopeRow = vestaRows.find(
        (row) =>
          row.ns === 'c2' && row.subject === 'seat' && row.kind === 'config' && row.id === 'scope'
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
      const watched = [vestaSeat, ...targets]
      const dueNow = watched.filter((scopeRef) =>
        scopeRef === vestaSeat ? readVesta : due(scopeRef)
      )
      // The rolling safety net: the oldest few seats past `fullRefreshMs`, after the dirty ones.
      const aged = [...targets]
        .filter((scopeRef) => !due(scopeRef) && ageOf(scopeRef) >= options.fullRefreshMs)
        .sort((a, b) => ageOf(b) - ageOf(a))
        .slice(0, AGED_PER_PASS)
      const reads = [...dueNow, ...aged]
      const results = await mapLimit(reads, SCAN_CONCURRENCY, (scopeRef) =>
        observeSeat(scopeRef, at, scopeRef === vestaSeat ? vestaRows : undefined)
      )
      reads.forEach((scopeRef, i) =>
        cache.set(scopeRef, {
          ...(results[i] as Omit<SeatObservation, 'readAt'>),
          readAt: startedAt,
        })
      )
      const kept = new Set(watched)
      for (const scopeRef of cache.keys()) if (!kept.has(scopeRef)) cache.delete(scopeRef)
      watchedSeats = kept

      const seats: SeatRow[] = []
      const annotations: AnnotationRow[] = []
      for (const scopeRef of watched) {
        const result = cache.get(scopeRef)
        if (result === undefined) continue
        if (result.seat !== undefined) {
          seats.push(result.seat)
          hostSessions.set(
            `${result.seat.sessionRef}#${result.seat.generation}`,
            result.seat.hostSessionId
          )
        }
        annotations.push(...result.rows)
        for (const row of result.rows) {
          if (
            row.subject === 'generation' &&
            typeof row.generation === 'number' &&
            row.hostSessionId
          )
            hostSessions.set(
              `${row.scopeRef}/lane:${row.laneRef ?? 'main'}#${row.generation}`,
              row.hostSessionId
            )
        }
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
    } catch (error) {
      // Nothing from a failed pass is kept: what it was to read stays due.
      if (full) allDirty = true
      for (const scopeRef of taken) dirty.add(scopeRef)
      throw error
    }
  }

  function shared(): Promise<Observation> {
    if (observing !== null && observing.epoch === epoch) return observing.promise
    // A write or freshen since the in-flight pass started: run a new pass after it.
    const prior = observing?.promise
    const run = prior === undefined ? observe() : prior.then(observe, observe)
    const entry = {
      epoch,
      promise: run.finally(() => {
        if (observing === entry) observing = null
      }),
    }
    observing = entry
    return entry.promise
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

  async function write<T>(key: Key, run: () => Promise<T>): Promise<T | Refusal> {
    try {
      return await run()
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal !== undefined) return refusal
      if (isUnreachable(error))
        return { code: 'hrc_unavailable', detail: { reason: String(error) } }
      throw error
    } finally {
      // Settled either way: the next read re-reads this seat (and joins no earlier pass).
      freshen([splitSessionRef(key.sessionRef).scopeRef])
    }
  }

  /** T-12233 §3: the terminated runtime of one generation, or null while not confirmed. */
  async function runtimeEnd(sessionRef: string, generation: number) {
    const hostSessionId = hostSessions.get(`${sessionRef}#${generation}`)
    if (hostSessionId === undefined) return null
    const runtimes = (await client.listRuntimes({ hostSessionId, all: true })).filter(
      (r) => r.generation === generation
    )
    if (runtimes.length === 0 || runtimes.some((r) => r.status !== TERMINATED)) return null
    const last = runtimes.reduce((a, r) =>
      (r.statusChangedAt ?? r.updatedAt) > (a.statusChangedAt ?? a.updatedAt) ? r : a
    )
    const state = last.runtimeStateJson as { terminationReason?: unknown } | undefined
    const reason =
      typeof state?.terminationReason === 'string'
        ? state.terminationReason
        : (last.lifecycleTerminalReason ?? null)
    return { runtimeId: last.runtimeId, terminatedReason: reason }
  }

  return {
    node,
    freshen,
    close() {
      closed = true
      following = false
      followAbort.abort()
    },
    runtimeEnd,
    ...(options.handoffSince !== undefined ? { handoffSince: options.handoffSince } : {}),
    async seats() {
      return (await shared()).seats
    },
    async annotations() {
      return (await shared()).annotations
    },
    put(key: Key, body: object, expect?: Expect, as?: string) {
      return write(key, async () => {
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
      return write(key, async () =>
        client.actOnSessionAnnotation(
          { ...keyFields(key), action, attributes: attributes as Record<string, unknown> },
          { principalRef: as ?? options.principal }
        )
      )
    },
    delete(key: Key, expect?: Expect, as?: string) {
      return write(key, async () =>
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
    onDirty(cb: () => void) {
      dirtyListeners.add(cb)
      return () => {
        dirtyListeners.delete(cb)
      }
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
