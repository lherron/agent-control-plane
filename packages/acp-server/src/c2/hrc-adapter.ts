/**
 * C2 observation over the local HRC socket. One bounded lifecycle follower
 * invalidates exact seats. Bootstrap and stream recovery discover continuities
 * and c2 rows once; unchanged seats never trigger age-based HRC reads.
 * Action freshen and literal-input fences remain authoritative fresh reads.
 */
import { HrcDomainError, type HrcLifecycleEvent } from 'hrc-core'

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
  | 'watchBoundedEvents'
>

export type C2HrcHostOptions = {
  client: C2HrcClient
  vestaSeat: string
  /** The controller's own principal (D9), used when a write names none. */
  principal: string
  node?: string | undefined
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

const SCAN_CONCURRENCY = 8
const TASK_SEAT = /:task:T-/
/** Only a recorded termination confirms an end; any other status may be a liveness blip (the hold). */
const TERMINATED = 'terminated'
const FOLLOW_BACKOFF_MIN_MS = 500
const FOLLOW_BACKOFF_MAX_MS = 30_000

type Observation = { seats: SeatRow[]; annotations: AnnotationRow[] }

/** One seat's last read: its live row (absent when unobservable or unknown) and its rows. */
type SeatObservation = { seat?: SeatRow; rows: AnnotationRow[] }

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
  return {
    source: a.source,
    state: a.state,
    kind: a.kind,
    at: a.at,
    excerpt: a.excerpt ?? null,
    // The turn's whole final message (T-12644); absent from an older HRC.
    ...(typeof a.text === 'string' ? { text: a.text } : {}),
  }
}

type SessionAttentionWire = {
  source: string
  state: string
  kind: string
  at: string
  excerpt?: string | null | undefined
  text?: string | undefined
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
  let continuities = new Set<string>()
  const continuityHosts = new Map<string, string>()
  const archivedSeats = new Set<string>()
  const membershipUpdates = new Map<string, HrcLifecycleEvent>()
  let rowSeats = new Set<string>()
  let resyncRevision = 1
  let syncedRevision = 0
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
  /** Last fully consumed row and its ledger fence. */
  let lastSeq: number | undefined
  let incarnation: string | undefined
  let hasConnected = false
  let following = false
  let nodeRead: Promise<string> | undefined
  let closed = false
  const followAbort = new AbortController()
  /** `<sessionRef>#<generation>` → that generation's host session, from observed c2 rows and seats. */
  const hostSessions = new Map<string, string>()

  async function node(): Promise<string> {
    if (resolvedNode !== undefined) return resolvedNode
    if (nodeRead !== undefined) return nodeRead
    const read = (async () => {
      const status = await client.getStatus({ includeSessions: false })
      const declared = (status as { node?: { nodeId?: unknown } }).node?.nodeId
      if (typeof declared !== 'string' || declared.trim() === '') {
        throw new Error('HRC status declares no node id')
      }
      return declared.trim()
    })()
    nodeRead = read
    try {
      const value = await read
      if (nodeRead === read) resolvedNode = value
      return value
    } finally {
      if (nodeRead === read) nodeRead = undefined
    }
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
    continuityHosts.clear()
    archivedSeats.clear()
    for (const session of sessions) {
      if (TASK_SEAT.test(session.scopeRef)) continue
      if (session.status === 'archived') {
        archivedSeats.add(session.scopeRef)
        continue
      }
      scopes.add(session.scopeRef)
      continuityHosts.set(session.scopeRef, session.hostSessionId)
    }
    continuities = scopes
    if (options.ownsUnscoped) {
      const found = new Set<string>()
      await mapLimit([...continuities].sort(), SCAN_CONCURRENCY, async (scopeRef) => {
        const read = await readSeat(scopeRef, 'annotations', () => c2Rows(scopeRef))
        if (read.ok && read.value !== undefined && read.value.length > 0) found.add(scopeRef)
      })
      // Events arriving during discovery are retained for the subsequent read.
      for (const scopeRef of dirty) if (rowSeats.has(scopeRef)) found.add(scopeRef)
      rowSeats = found
    }
    for (const event of membershipUpdates.values()) applyMembership(event)
    membershipUpdates.clear()
  }

  async function ensureSwept(): Promise<void> {
    if (syncedRevision === resyncRevision) return
    if (sweeping === null) {
      const revision = resyncRevision
      sweeping = sweep()
        .then(() => {
          syncedRevision = revision
        })
        .finally(() => {
          sweeping = null
        })
    }
    await sweeping
  }

  async function observeSeat(
    scopeRef: string,
    at: string,
    listedRows?: AnnotationRow[]
  ): Promise<SeatObservation> {
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
    if (options.ownsUnscoped && !archivedSeats.has(scopeRef) && rows !== undefined) {
      if (rows.some((row) => row.ns === 'c2')) rowSeats.add(scopeRef)
      else rowSeats.delete(scopeRef)
    }
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

  function wake(): void {
    for (const listener of dirtyListeners) {
      try {
        listener()
      } catch (error) {
        log(`c2: dirty listener failed: ${String(error)}`)
      }
    }
  }

  function resync(): void {
    resyncRevision += 1
    allDirty = true
    epoch += 1
    resolvedNode = options.node
    nodeRead = undefined
    // A new stream may be a new HRC process with the same ledger incarnation.
    for (const [key, entry] of runtimeEnds) if (entry.value === null) runtimeEnds.delete(key)
    wake()
  }

  function applyMembership(event: HrcLifecycleEvent): void {
    if (TASK_SEAT.test(event.scopeRef)) return
    const payload = event.payload as { status?: unknown } | null
    if (event.eventKind === 'session.archived' || payload?.status === 'archived') {
      const current =
        continuityHosts.get(event.scopeRef) ?? cache.get(event.scopeRef)?.seat?.hostSessionId
      if (current === undefined || current === event.hostSessionId) {
        continuities.delete(event.scopeRef)
        continuityHosts.delete(event.scopeRef)
        rowSeats.delete(event.scopeRef)
        archivedSeats.add(event.scopeRef)
        cache.delete(event.scopeRef)
      }
    } else if (
      ['session.created', 'session.born', 'session.rotated', 'session.started'].includes(
        event.eventKind
      ) ||
      payload?.status === 'active'
    ) {
      continuities.add(event.scopeRef)
      continuityHosts.set(event.scopeRef, event.hostSessionId)
      archivedSeats.delete(event.scopeRef)
    }
  }

  function invalidate(event: HrcLifecycleEvent): void {
    lastSeq = event.hrcSeq
    dirty.add(event.scopeRef)
    const payload = event.payload as { ns?: unknown } | null
    if (
      options.ownsUnscoped &&
      !archivedSeats.has(event.scopeRef) &&
      event.eventKind.startsWith('session.annotation.') &&
      payload?.ns === 'c2'
    )
      rowSeats.add(event.scopeRef)
    if (
      event.eventKind.startsWith('session.') &&
      !event.eventKind.startsWith('session.annotation.')
    ) {
      if (sweeping !== null) membershipUpdates.set(event.scopeRef, event)
      applyMembership(event)
    }
    if (event.eventKind.startsWith('runtime.') || event.eventKind.includes('terminated')) {
      const key = `${event.scopeRef}/lane:${event.laneRef || 'main'}#${event.generation}`
      const entry = runtimeEnds.get(key)
      if (entry?.value === null) runtimeEnds.delete(key)
    }
    if (
      watchedSeats.has(event.scopeRef) ||
      rowSeats.has(event.scopeRef) ||
      event.eventKind.startsWith('session.')
    )
      wake()
  }

  async function follow(initialSeed: ReturnType<C2HrcClient['tailEvents']>): Promise<void> {
    let seed = initialSeed
    let backoff = FOLLOW_BACKOFF_MIN_MS
    while (!closed) {
      try {
        const tail = await seed
        if (incarnation !== tail.ledgerIncarnationId) {
          if (incarnation !== undefined) {
            runtimeEnds.clear()
            hostSessions.clear()
          }
          incarnation = tail.ledgerIncarnationId
          lastSeq = tail.headHrcSeq
        }
        const afterSeq = lastSeq ?? tail.headHrcSeq
        for await (const record of client.watchBoundedEvents({
          ledgerIncarnationId: incarnation,
          afterSeq,
          signal: followAbort.signal,
        })) {
          if (record.type === 'ready') {
            following = true
            if (hasConnected) resync()
            hasConnected = true
            log(`c2.follow.connected fromSeq=${afterSeq + 1}`)
            backoff = FOLLOW_BACKOFF_MIN_MS
          } else if (record.type === 'gap' || record.type === 'ledger_replaced') {
            // Reopen from a current, incarnation-fenced head and resync once at ready.
            if (record.type === 'ledger_replaced') {
              incarnation = undefined
              runtimeEnds.clear()
              hostSessions.clear()
            }
            lastSeq = undefined
            break
          } else if (record.type === 'home_unreachable') {
            break
          } else {
            invalidate(record.event)
          }
        }
        if (closed) return
        throw new Error('event stream ended')
      } catch (error) {
        if (closed) return
        following = false
        wake()
        log(`c2.follow.down ${String(error)}: retaining last observation until reconnect`)
        await sleep(backoff)
        if (closed) return
        backoff = Math.min(backoff * 2, FOLLOW_BACKOFF_MAX_MS)
        seed = client.tailEvents({ limit: 1 })
      }
    }
  }
  let seed: ReturnType<C2HrcClient['tailEvents']> | undefined

  async function observe(): Promise<Observation> {
    if (seed === undefined) {
      seed = client.tailEvents({ limit: 1 })
      void follow(seed)
    }
    // Establish the replay cursor before discovery, so concurrent writes are not lost.
    await seed.catch((error) => {
      if (!hasConnected) throw error
    })
    await ensureSwept()
    const at = await node()
    const full = allDirty
    // Take this pass's dirty set; an event landing during the read marks the next pass.
    const taken = new Set(dirty)
    dirty.clear()
    if (full) allDirty = false
    const due = (scopeRef: string) => full || taken.has(scopeRef) || !cache.has(scopeRef)
    try {
      const readVesta = due(vestaSeat)
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
      const targets = new Set<string>(
        [...rowSeats, ...[...continuities].filter(allowed)].filter(
          (scopeRef) => !archivedSeats.has(scopeRef)
        )
      )
      targets.delete(vestaSeat)
      const watched = [vestaSeat, ...targets]
      const dueNow = watched.filter((scopeRef) =>
        scopeRef === vestaSeat ? readVesta : due(scopeRef)
      )
      const reads = dueNow
      const results = await mapLimit(reads, SCAN_CONCURRENCY, (scopeRef) =>
        observeSeat(scopeRef, at, scopeRef === vestaSeat ? vestaRows : undefined)
      )
      reads.forEach((scopeRef, i) =>
        cache.set(scopeRef, {
          ...(results[i] as SeatObservation),
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

  type RuntimeEnd = { runtimeId: string; terminatedReason: string | null }
  type RuntimeEndEntry = {
    value: RuntimeEnd | null
    pending?: Promise<RuntimeEnd | null> | undefined
  }
  const runtimeEnds = new Map<string, RuntimeEndEntry>()

  /** Query once per card, then only after a relevant runtime event. */
  async function runtimeEnd(sessionRef: string, generation: number): Promise<RuntimeEnd | null> {
    const key = `${sessionRef}#${generation}`
    const hostSessionId = hostSessions.get(key)
    if (hostSessionId === undefined) return null
    const cached = runtimeEnds.get(key)
    if (cached !== undefined) return cached.pending ?? cached.value
    const entry: RuntimeEndEntry = { value: null }
    const pending = (async () => {
      try {
        const runtimes = (await client.listRuntimes({ hostSessionId, all: true })).filter(
          (r) => r.generation === generation
        )
        if (runtimes.length === 0 || runtimes.some((r) => r.status !== TERMINATED)) return null
        const last = runtimes.reduce((a, r) =>
          (r.statusChangedAt ?? r.updatedAt) > (a.statusChangedAt ?? a.updatedAt) ? r : a
        )
        const state = last.runtimeStateJson as { terminationReason?: unknown } | undefined
        const value = {
          runtimeId: last.runtimeId,
          terminatedReason:
            typeof state?.terminationReason === 'string'
              ? state.terminationReason
              : (last.lifecycleTerminalReason ?? null),
        }
        entry.value = value
        return value
      } catch (error) {
        if (runtimeEnds.get(key) === entry) runtimeEnds.delete(key)
        throw error
      } finally {
        entry.pending = undefined
      }
    })()
    entry.pending = pending
    runtimeEnds.set(key, entry)
    return pending
  }

  return {
    node() {
      if (hasConnected && !following)
        return Promise.reject(new Error('HRC event follower disconnected'))
      return node()
    },
    freshen,
    close() {
      closed = true
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
