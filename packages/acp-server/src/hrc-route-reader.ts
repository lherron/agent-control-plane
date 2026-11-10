/**
 * The HRC read routes ACP's launcher, sweeps and reaper decide from (T-13243).
 *
 * ACP no longer opens HRC's store. Every read goes through one of these
 * routes, with the selectors hrc-runtime added in T-13244. Row shapes are the
 * wire shapes from real calls against max3's HRC on 2026-11-10: a null column
 * is omitted, not sent as null (`completedAt` on an open run, `launchId`,
 * `evidenceOrigin`, `tmuxJson` on a non-tmux runtime).
 *
 * An HRC daemon ignores an unknown query key (hrc-runtime ruling, EN-50591),
 * so a daemon without a selector silently returns unfiltered rows. Callers
 * therefore re-check every selector's condition on the rows they get back;
 * where a stray row could change a decision they take the safe branch.
 */
import type { SessionRef } from 'agent-scope'

/** One `/v1/events` or `/v1/events/tail` row, as far as ACP reads it. */
export type HrcEventRow = {
  hrcSeq: number
  ts: string
  eventKind: string
  hostSessionId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  generation?: number | undefined
  runId?: string | undefined
  launchId?: string | undefined
  /** Present only on history rows (today `'retained'`); live rows omit it. */
  evidenceOrigin?: string | undefined
  payload?: unknown
}

export type HrcEventSelectors = {
  runId?: string | undefined
  hostSessionId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  generation?: number | undefined
  /** Exact kinds, sent as a comma list. */
  eventKind?: readonly string[] | undefined
  /** T-13244: drop rows that carry an evidence origin. */
  liveOnly?: boolean | undefined
}

/** Non-follow `GET /v1/events`: oldest first, through the head at the first read. */
export type HrcEventQuery = HrcEventSelectors & {
  /** Inclusive lower bound on hrcSeq (at least 1). */
  fromSeq?: number | undefined
  limit?: number | undefined
  /** T-13244: inclusive bounds on `ts`, compared as stored text. */
  fromTs?: string | undefined
  toTs?: string | undefined
}

/** `GET /v1/events/tail`: the newest `limit` rows (at most 500). */
export type HrcEventTailQuery = HrcEventSelectors & {
  limit: number
  /** T-13244: exclusive lower bound on hrcSeq. */
  afterSeq?: number | undefined
  /** Exclusive upper bound; requires ledgerIncarnationId. */
  beforeHrcSeq?: number | undefined
  ledgerIncarnationId?: string | undefined
}

export type HrcEventTail = {
  events: HrcEventRow[]
  headHrcSeq: number
  ledgerIncarnationId?: string | undefined
  truncated: boolean
}

/** One `GET /v1/runs` row, as far as ACP reads it. */
export type HrcRunRow = {
  runId: string
  status: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  generation?: number | undefined
  acceptedAt?: string | undefined
  completedAt?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  updatedAt?: string | undefined
}

export type HrcRunQuery = {
  runId?: string | undefined
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  /** T-13244: inclusive. */
  acceptedSince?: string | undefined
  /** T-13244: exclusive. */
  acceptedBefore?: string | undefined
  /** T-13244: inclusive. */
  completedSince?: string | undefined
  /** T-13244: only runs with no completedAt. */
  open?: boolean | undefined
  /** T-13244: completedAt DESC, runId DESC; the default is updatedAt DESC. */
  order?: 'completedAt' | undefined
  limit?: number | undefined
}

/** One `GET /v1/runtimes` row, as far as ACP reads it. */
export type HrcRuntimeRow = {
  runtimeId: string
  status: string
  hostSessionId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  transport?: string | undefined
  updatedAt?: string | undefined
  tmuxJson?: unknown
}

export type HrcRuntimeQuery = {
  /** T-13244: exact. */
  runtimeId?: string | undefined
  hostSessionId?: string | undefined
  /** T-13244: exact (`scope` stays a prefix match). */
  scopeRef?: string | undefined
  /** T-13244: exact. */
  laneRef?: string | undefined
  transport?: string | undefined
  /** Include terminal rows; HRC hides ten terminal statuses otherwise. */
  all?: boolean | undefined
}

export interface HrcRouteReader {
  /** Non-follow `GET /v1/events`. */
  readEvents(query: HrcEventQuery): Promise<HrcEventRow[]>
  /** `GET /v1/events/tail`. Federation-routed when keyed by scopeRef. */
  readEventTail(query: HrcEventTailQuery): Promise<HrcEventTail>
  /** `GET /v1/runs`. Federation-routed when keyed by scopeRef. */
  readRuns(query: HrcRunQuery): Promise<HrcRunRow[]>
  /** `GET /v1/runtimes`, every page. */
  readRuntimes(query: HrcRuntimeQuery): Promise<HrcRuntimeRow[]>
  /**
   * `GET /v1/sessions/get`: the continuity's active host session id, or
   * undefined when HRC has no continuity for the session (404).
   */
  readActiveHostSessionId(sessionRef: SessionRef): Promise<string | undefined>
}

/** True when a row carries any evidence origin (history, never current work). */
export function isRetainedEvent(event: { evidenceOrigin?: unknown }): boolean {
  return event.evidenceOrigin !== undefined && event.evidenceOrigin !== null
}

/** Re-check the event selectors a query sent on one returned row. */
export function eventMatches(event: HrcEventRow, query: HrcEventSelectors): boolean {
  if (query.runId !== undefined && event.runId !== query.runId) return false
  if (query.hostSessionId !== undefined && event.hostSessionId !== query.hostSessionId) return false
  if (query.scopeRef !== undefined && event.scopeRef !== query.scopeRef) return false
  if (query.laneRef !== undefined && event.laneRef !== query.laneRef) return false
  if (query.generation !== undefined && event.generation !== query.generation) return false
  if (query.eventKind !== undefined && !query.eventKind.includes(event.eventKind)) return false
  if (query.liveOnly === true && isRetainedEvent(event)) return false
  return true
}
