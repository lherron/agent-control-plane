import type {
  HrcLifecycleEvent,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'

import type { AcpHrcClient } from '../deps.js'

// T-11794: a dashboard socket used to make four HRC reads for every lifecycle
// event, so HRC load was events × open dashboards. A session's summary is now
// refreshed once per window after its first event, from reads shared across
// sockets. Failure modes: var/wrkq-artifacts/T-11794/failure-modes.md.
export const DASHBOARD_SESSION_REFRESH_COALESCE_MS = 500
const SHARED_READ_RETAIN_MS = 5_000

export type DashboardSessionInputs = {
  record: HrcSessionRecord
  runtimes: HrcRuntimeSnapshot[]
  lastEvent: HrcLifecycleEvent | undefined
  run: HrcRunRecord | null | undefined
}

export type DashboardSessionReads = {
  /** Reads a session's summary inputs, reusing a read that started at or after `notBefore`. */
  read(event: HrcLifecycleEvent, notBefore: number): Promise<DashboardSessionInputs | undefined>
}

type SharedRead = {
  startedAt: number
  promise: Promise<DashboardSessionInputs | undefined>
}

function sessionKey(event: HrcLifecycleEvent): string {
  return `${event.scopeRef}\u0000${event.laneRef}\u0000${event.hostSessionId}\u0000${event.generation}`
}

async function readSessionInputs(
  hrcClient: AcpHrcClient,
  event: HrcLifecycleEvent
): Promise<DashboardSessionInputs | undefined> {
  const records = await hrcClient.listSessions({
    scopeRef: event.scopeRef,
    laneRef: event.laneRef,
  })
  const record = records.find(
    (candidate) =>
      candidate.hostSessionId === event.hostSessionId && candidate.generation === event.generation
  )
  if (record === undefined) return undefined

  const [runtimes, [lastEvent], run] = await Promise.all([
    hrcClient.listRuntimes({ hostSessionId: record.hostSessionId }),
    hrcClient.listLatestEventBySession({
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    }),
    hrcClient.getLatestRunForSession({
      hostSessionId: record.hostSessionId,
      generation: record.generation,
    }),
  ])
  return { record, runtimes, lastEvent, run }
}

export function createDashboardSessionReads(
  hrcClient: AcpHrcClient,
  now: () => number = () => performance.now()
): DashboardSessionReads {
  const reads = new Map<string, SharedRead>()
  return {
    read(event, notBefore) {
      const key = sessionKey(event)
      const existing = reads.get(key)
      if (existing !== undefined && existing.startedAt >= notBefore) return existing.promise

      const entry: SharedRead = {
        startedAt: now(),
        promise: readSessionInputs(hrcClient, event),
      }
      reads.set(key, entry)
      const forget = (): void => {
        setTimeout(() => {
          if (reads.get(key) === entry) reads.delete(key)
        }, SHARED_READ_RETAIN_MS).unref?.()
      }
      entry.promise.then(forget, () => {
        // A failed read is never reused.
        if (reads.get(key) === entry) reads.delete(key)
      })
      return entry.promise
    },
  }
}

const sharedReadsByClient = new WeakMap<AcpHrcClient, DashboardSessionReads>()

/** One read cache per HRC client, so every dashboard socket on this server shares it. */
export function sharedDashboardSessionReads(hrcClient: AcpHrcClient): DashboardSessionReads {
  let reads = sharedReadsByClient.get(hrcClient)
  if (reads === undefined) {
    reads = createDashboardSessionReads(hrcClient)
    sharedReadsByClient.set(hrcClient, reads)
  }
  return reads
}

type PendingSession = { event: HrcLifecycleEvent; receivedAt: number }

export type DashboardSessionRefresher = {
  /** Records an event for its session; the session refreshes when its window closes. */
  note(event: HrcLifecycleEvent): void
  /** Refreshes every pending session now and waits for queued refreshes. */
  drain(): Promise<void>
}

/**
 * Per-socket coalescer. Refreshes run one at a time in order, so a session's
 * summaries never overtake each other. The first failed read is reported and
 * ends refreshing; the caller closes the socket as it did for a failed read.
 */
export function createDashboardSessionRefresher(input: {
  reads: DashboardSessionReads
  signal: AbortSignal
  onRefresh(latest: HrcLifecycleEvent, inputs: DashboardSessionInputs | undefined): void
  onError(error: unknown): void
  coalesceMs?: number | undefined
  now?: (() => number) | undefined
}): DashboardSessionRefresher {
  const coalesceMs = input.coalesceMs ?? DASHBOARD_SESSION_REFRESH_COALESCE_MS
  const now = input.now ?? (() => performance.now())
  const windows = new Map<
    string,
    { pending: PendingSession; timer: ReturnType<typeof setTimeout> }
  >()
  let queue = Promise.resolve()
  let failed = false

  const refresh = async (pending: PendingSession): Promise<void> => {
    if (failed || input.signal.aborted) return
    try {
      const inputs = await input.reads.read(pending.event, pending.receivedAt)
      if (failed || input.signal.aborted) return
      input.onRefresh(pending.event, inputs)
    } catch (error) {
      if (failed || input.signal.aborted) return
      failed = true
      input.onError(error)
    }
  }

  const close = (key: string): void => {
    const window = windows.get(key)
    if (window === undefined) return
    clearTimeout(window.timer)
    windows.delete(key)
    queue = queue.then(() => refresh(window.pending))
  }

  input.signal.addEventListener(
    'abort',
    () => {
      for (const window of windows.values()) clearTimeout(window.timer)
      windows.clear()
    },
    { once: true }
  )

  return {
    note(event) {
      if (failed || input.signal.aborted) return
      const key = sessionKey(event)
      const pending = { event, receivedAt: now() }
      const window = windows.get(key)
      if (window !== undefined) {
        window.pending = pending
        return
      }
      windows.set(key, { pending, timer: setTimeout(() => close(key), coalesceMs) })
    },
    async drain() {
      for (const key of [...windows.keys()]) close(key)
      await queue
    },
  }
}
