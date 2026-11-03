/**
 * Keyed HRC facts, fed by the lifecycle follow (T-12430).
 *
 * The drive, the sweep and the ledger tail asked HRC the same questions about
 * unchanged seats on every pass: where a scope is homed, which session a target
 * has, which seats are live, which births this node owes. Those answers change
 * only when HRC commits a lifecycle event for the session, scope or runtime they
 * belong to. This module keeps one answer per key and drops that exact key when
 * such an event arrives. A key is read from HRC only when it is missing or
 * dirty.
 *
 * What is NOT here, on purpose. Busy/idle seat state, the runtime and seat reads
 * in the delivery preflight, and every broker-evidence query are always read
 * fresh. A cached value may decide that a drive has nothing to do. It never
 * authorizes a door: every acting path re-reads the target and the home first
 * (`fresh: true`), and a receipt still comes only from broker or lifecycle
 * evidence. See `var/wrkq-artifacts/T-12430/failure-modes.md`.
 *
 * Invalidation uses a DENY-list. Only kinds known to change no session, scope,
 * placement or liveness fact leave keys clean, so a kind HRC adds later dirties
 * its keys rather than going stale (F1). Even a known-benign event dirties its
 * target when it names a host or a newer generation the cached session lacks.
 *
 * The cache serves only while the lifecycle follow is attached and up. With no
 * feed to invalidate it (subscription not started, stream down, a unit test
 * with no controller) every read goes to HRC, as before.
 */
import type { HrcLifecycleEvent, HrcSessionRecord, ListUnbornDesignationsResponse } from 'hrc-core'

import type { ForeignHome } from '../contracts.js'
import { formatSessionRef } from '../internal.js'

/** A cached "homed elsewhere" verdict strands mail if it is wrong; bound it (F5). */
export const FOREIGN_HOME_TTL_MS = 5 * 60_000
/** Designations are written by other nodes and announce nothing here. */
export const DESIGNATIONS_TTL_MS = 5 * 60_000

const BENIGN_PREFIXES = ['turn.', 'broker.', 'submission.']
const BENIGN_KINDS = new Set([
  'runtime.context.updated',
  'runtime.presentation',
  'session.annotation.changed',
  'target.literal-input',
])
const INCARNATION_PREFIX = 'server.'
const INCARNATION_KINDS = new Set(['store.migrated'])

export function isStructuralLifecycleKind(eventKind: string): boolean {
  if (BENIGN_KINDS.has(eventKind)) return false
  return !BENIGN_PREFIXES.some((prefix) => eventKind.startsWith(prefix))
}

type FactsReadPort = {
  resolveForeignHome(scopeRef: string): Promise<ForeignHome | undefined>
  locate(scopeRef: string): Promise<ForeignHome | undefined>
  targetBySessionRef(targetSessionRef: string): Promise<HrcSessionRecord | undefined>
  liveSessionRefs(): Promise<readonly string[]>
  unbornDesignations(): Promise<ListUnbornDesignationsResponse>
}

type Entry<T> = { value: T; epoch: number; version: number; atMs: number }

/** Per-key read counts, for diagnostics and the T-12430 tests. */
export type FactReadCounts = Record<'home' | 'locate' | 'target' | 'live' | 'designations', number>

/** Reconcile memo for one intent; see `drive/reconcile.ts`. */
export type ReconcileMemo = {
  fingerprint: string
  /** The facts epoch the examination ran in; a resume re-examines once. */
  epoch: string
  /** `HrcFacts.tick` when the examination STARTED (F9). */
  tick: number
  examinedAtMs: number
}

export class HrcFacts {
  private lifecycleAttached = false
  private lifecycleUp = true
  private brokerAttached = false
  private brokerUp = true
  private lifecycleEpoch = 0
  private brokerEpoch = 0
  private nextTick = 1
  private readonly versions = new Map<string, number>()
  private readonly entries = new Map<string, Entry<unknown>>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  readonly reads: FactReadCounts = { home: 0, locate: 0, target: 0, live: 0, designations: 0 }

  /** Broker commit notifications per submission/envelope, and per runtime for unbound intents. */
  readonly dirtyEnvelopes = new Map<string, number>()
  readonly dirtyRuntimes = new Map<string, number>()
  readonly reconcileMemo = new Map<string, ReconcileMemo>()
  /** Lapse sweep: runtime → runtime version it was last seen live at. */
  readonly liveRuntimeMemo = new Map<string, string>()
  /** Stalled launch check: envelope → scope version its scope was last seen live at. */
  readonly stalledLaunchMemo = new Map<string, string>()

  constructor(
    private readonly port: () => FactsReadPort,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Whether reads are served from keyed state (the lifecycle feed is attached and up). */
  get serving(): boolean {
    return this.lifecycleAttached && this.lifecycleUp
  }

  /** Whether reconcile may key evidence reads to broker commit notifications. */
  get brokerKeyed(): boolean {
    return this.serving && this.brokerAttached && this.brokerUp
  }

  /** Changes on every reset or resume of either feed. */
  get epoch(): string {
    return `${this.lifecycleEpoch}:${this.brokerEpoch}`
  }

  tick(): number {
    return this.nextTick++
  }

  attachLifecycle(): void {
    this.lifecycleAttached = true
    this.lifecycleUp = true
  }

  attachBroker(): void {
    this.brokerAttached = true
    this.brokerUp = true
  }

  detach(): void {
    this.lifecycleAttached = false
    this.brokerAttached = false
    this.reset()
  }

  /** F2: a dropped stream bypasses the cache; its resume revalidates every key once. */
  lifecycleStreamState(state: 'down' | 'resumed'): void {
    if (state === 'down') {
      this.lifecycleUp = false
      return
    }
    this.reset()
    this.lifecycleUp = true
  }

  brokerStreamState(state: 'down' | 'resumed'): void {
    if (state === 'down') {
      this.brokerUp = false
      return
    }
    this.brokerEpoch += 1
    this.brokerUp = true
  }

  /** F2/F3: forget every key. The next use of each reads HRC once. */
  reset(): void {
    this.lifecycleEpoch += 1
    this.entries.clear()
    this.versions.clear()
    this.liveRuntimeMemo.clear()
    this.stalledLaunchMemo.clear()
  }

  // --- versions, for consumers that memo against a key ----------------------

  scopeVersion(scopeRef: string): string {
    return `${this.lifecycleEpoch}:${this.versions.get(`scope:${scopeRef}`) ?? 0}`
  }

  runtimeVersion(runtimeId: string): string {
    return `${this.lifecycleEpoch}:${this.versions.get(`runtime:${runtimeId}`) ?? 0}`
  }

  // --- reads -----------------------------------------------------------------

  async foreignHome(
    scopeRef: string,
    options: { fresh?: boolean } = {}
  ): Promise<ForeignHome | undefined> {
    return await this.read(
      `home:${scopeRef}`,
      'home',
      () => this.port().resolveForeignHome(scopeRef),
      options,
      (value) => (value === undefined ? undefined : FOREIGN_HOME_TTL_MS)
    )
  }

  async locate(
    scopeRef: string,
    options: { fresh?: boolean } = {}
  ): Promise<ForeignHome | undefined> {
    return await this.read(
      `locate:${scopeRef}`,
      'locate',
      () => this.port().locate(scopeRef),
      options,
      (value) => (value === undefined ? undefined : FOREIGN_HOME_TTL_MS)
    )
  }

  async target(
    targetSessionRef: string,
    options: { fresh?: boolean } = {}
  ): Promise<HrcSessionRecord | undefined> {
    return await this.read(
      `target:${targetSessionRef}`,
      'target',
      () => this.port().targetBySessionRef(targetSessionRef),
      options
    )
  }

  async liveSessionRefs(): Promise<readonly string[]> {
    return await this.read('live', 'live', () => this.port().liveSessionRefs(), {})
  }

  async unbornDesignations(): Promise<ListUnbornDesignationsResponse> {
    return await this.read(
      'designations',
      'designations',
      () => this.port().unbornDesignations(),
      {},
      () => DESIGNATIONS_TTL_MS
    )
  }

  // --- invalidation ------------------------------------------------------------

  /** A refusal that names a placement or host change (F5), or a birth this node made. */
  invalidateTarget(targetSessionRef: string): void {
    const scopeRef = scopeOf(targetSessionRef)
    this.bump(`target:${targetSessionRef}`)
    if (scopeRef !== undefined) this.dirtyScope(scopeRef)
    this.bump('live')
    this.bump('designations')
  }

  /** Drop exactly the keys one lifecycle event can have changed. */
  observe(event: HrcLifecycleEvent): void {
    const kind = event.eventKind
    if (kind.startsWith(INCARNATION_PREFIX) || INCARNATION_KINDS.has(kind)) {
      this.reset()
      return
    }
    const targetSessionRef =
      event.scopeRef !== undefined && event.laneRef !== undefined
        ? formatSessionRef(event.scopeRef, event.laneRef)
        : undefined
    if (isStructuralLifecycleKind(kind)) {
      if (targetSessionRef !== undefined) this.invalidateTarget(targetSessionRef)
      else {
        this.bump('live')
        this.bump('designations')
      }
      if (event.runtimeId !== undefined) this.bump(`runtime:${event.runtimeId}`)
      return
    }
    // F1/F4: a benign kind still proves a rotation the cache missed.
    if (targetSessionRef === undefined || event.hostSessionId === undefined) return
    const cached = this.entries.get(`target:${targetSessionRef}`) as
      | Entry<HrcSessionRecord | undefined>
      | undefined
    if (cached === undefined) return
    const session = cached.value
    if (
      session === undefined ||
      session.hostSessionId !== event.hostSessionId ||
      (event.generation !== undefined && event.generation > session.generation)
    ) {
      this.invalidateTarget(targetSessionRef)
    }
  }

  private dirtyScope(scopeRef: string): void {
    this.bump(`scope:${scopeRef}`)
    this.bump(`home:${scopeRef}`)
    this.bump(`locate:${scopeRef}`)
  }

  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1)
    this.entries.delete(key)
  }

  private async read<T>(
    key: string,
    counter: keyof FactReadCounts,
    load: () => Promise<T>,
    options: { fresh?: boolean },
    ttlMs?: (value: T) => number | undefined
  ): Promise<T> {
    if (!this.serving) {
      this.reads[counter] += 1
      return await load()
    }
    if (options.fresh === true) this.bump(key)
    const entry = this.entries.get(key) as Entry<T> | undefined
    const version = this.versions.get(key) ?? 0
    if (entry !== undefined && entry.epoch === this.lifecycleEpoch && entry.version === version) {
      const ttl = ttlMs?.(entry.value)
      if (ttl === undefined || this.now() - entry.atMs < ttl) return entry.value
      this.entries.delete(key)
    }
    const pending = this.inflight.get(key) as Promise<T> | undefined
    if (pending !== undefined && options.fresh !== true) return await pending
    const epoch = this.lifecycleEpoch
    const read = (async () => {
      this.reads[counter] += 1
      const value = await load()
      // F4: an invalidation that landed while this read was out wins; the
      // answer is returned to its caller but never stored.
      if (this.lifecycleEpoch === epoch && (this.versions.get(key) ?? 0) === version) {
        this.entries.set(key, { value, epoch, version, atMs: this.now() })
      }
      return value
    })()
    this.inflight.set(key, read)
    try {
      return await read
    } finally {
      if (this.inflight.get(key) === read) this.inflight.delete(key)
    }
  }
}

function scopeOf(targetSessionRef: string): string | undefined {
  const index = targetSessionRef.lastIndexOf('/lane:')
  return index > 0 ? targetSessionRef.slice(0, index) : undefined
}

const factsByContext = new WeakMap<object, HrcFacts>()

/** The one keyed-facts instance for a kicker context, reading through its current port. */
export function hrcFacts(server: { readonly port: FactsReadPort }): HrcFacts {
  let facts = factsByContext.get(server)
  if (facts === undefined) {
    facts = new HrcFacts(() => server.port)
    factsByContext.set(server, facts)
  }
  return facts
}
