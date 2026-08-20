import type { HrcLifecycleEvent } from 'hrc-core'

import type { AcpHrcClient } from '../deps.js'

const DEFAULT_LATEST_EVENT_CACHE_TTL_MS = 5_000
const LATEST_EVENT_REFRESH_RETRY_TTL_MS = 1_000

type LatestEventFilter = Parameters<AcpHrcClient['listLatestEventBySession']>[0]

type LatestEventCacheEntry = {
  events?: HrcLifecycleEvent[] | undefined
  expiresAt: number
  pending?: Promise<HrcLifecycleEvent[]> | undefined
}

const latestEventsByClient = new WeakMap<AcpHrcClient, Map<string, LatestEventCacheEntry>>()

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function filterCacheKey(filter: LatestEventFilter): string {
  if (filter === undefined) {
    return '*'
  }

  return JSON.stringify(
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
  )
}

/**
 * Coalesce HRC's latest-event-per-session summary query and retain it briefly.
 *
 * The query is intentionally centralized here because it groups over the event
 * store. A stale value is safer than turning mobile/ops reads into an outage
 * when a refresh fails; callers naturally degrade sessions with no surviving
 * event to their session/runtime timestamps.
 */
export async function listCachedLatestEventBySession(
  hrcClient: AcpHrcClient,
  filter?: LatestEventFilter
): Promise<HrcLifecycleEvent[]> {
  let entries = latestEventsByClient.get(hrcClient)
  if (entries === undefined) {
    entries = new Map()
    latestEventsByClient.set(hrcClient, entries)
  }

  const key = filterCacheKey(filter)
  const now = Date.now()
  const existing = entries.get(key)
  if (existing?.events !== undefined && existing.expiresAt > now) {
    return existing.events
  }
  if (existing?.pending !== undefined) {
    return existing.pending
  }

  const entry = existing ?? { expiresAt: 0 }
  const pending = hrcClient
    .listLatestEventBySession(filter)
    .then((events) => {
      entry.events = events
      entry.expiresAt =
        Date.now() +
        readPositiveIntegerEnv(
          'ACP_HRC_LATEST_EVENT_CACHE_TTL_MS',
          DEFAULT_LATEST_EVENT_CACHE_TTL_MS
        )
      entry.pending = undefined
      return events
    })
    .catch((error: unknown) => {
      entry.pending = undefined
      if (entry.events !== undefined) {
        entry.expiresAt = Date.now() + LATEST_EVENT_REFRESH_RETRY_TTL_MS
        return entry.events
      }
      entries?.delete(key)
      throw error
    })

  entry.pending = pending
  entries.set(key, entry)
  return pending
}

export function latestHrcSeq(events: readonly HrcLifecycleEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.hrcSeq), 0)
}

export function boundedReplayFromSeq(input: {
  requestedFromSeq: number
  lastHrcSeq: number
  maxReplayEvents: number
}): number {
  const replayFloor = Math.max(1, input.lastHrcSeq - input.maxReplayEvents + 1)
  return Math.max(input.requestedFromSeq, replayFloor)
}
