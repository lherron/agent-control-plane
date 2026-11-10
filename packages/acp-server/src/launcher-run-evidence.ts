import { writeLogLine } from 'acp-core'
import type { HrcRouteReader, HrcRunRow } from './hrc-route-reader.js'

/** The first non-null launch id HRC recorded on the run's events. */
export async function findLaunchIdForRun(
  hrc: HrcRouteReader,
  runId: string
): Promise<string | undefined> {
  try {
    const events = await hrc.readEvents({ runId })
    return events.find((event) => event.runId === runId && typeof event.launchId === 'string')
      ?.launchId
  } catch {
    return undefined
  }
}

// A genuine launch is ACCEPTED by HRC within seconds of the ACP run being
// created (acceptance happens at turn start, NOT completion — even a fully cold
// runtime+broker provision is well under a minute). 5 minutes is ~10x headroom
// for cold-start/load, while rejecting unrelated turns dispatched far later that
// would otherwise falsely "prove" a long-dead pending run launched (T-04297
// follow-up: a 15:03 failed turn was kept "launched" by 17:18 e2e turns on the
// same host session, jamming every subsequent Discord message into a
// non-draining queue).
export const LAUNCH_CORRELATION_WINDOW_MS = 5 * 60_000

/**
 * Upper bound (exclusive) for `hasInFlightHrcRunSince` launch evidence: the HRC
 * run must have been accepted within LAUNCH_CORRELATION_WINDOW_MS of the ACP run
 * being created. Returns undefined for an unparseable timestamp (caller then
 * falls back to the unbounded, lower-edge-only query).
 */
export function launchCorrelationUntilIso(createdAtIso: string): string | undefined {
  const createdMs = Date.parse(createdAtIso)
  if (Number.isNaN(createdMs)) {
    return undefined
  }
  return new Date(createdMs + LAUNCH_CORRELATION_WINDOW_MS).toISOString()
}

// Why this only counts IN-FLIGHT (non-terminal) HRC runs as launch evidence:
//
// A pending ACP run with no hrcRunId is the NORMAL state of a long-running
// SDK-headless turn — `dispatchTurn(waitForCompletion: true)` blocks until the
// HRC turn completes, and the ACP run's hrcRunId is only written AFTER it
// returns. So while the turn is genuinely processing, the protective evidence
// must keep the stale-blocker sweep from killing it.
//
// But once the correlated HRC run reaches a TERMINAL state (completed_at set)
// while the ACP run is STILL pending with no hrcRunId, the ACP-side write-back
// was permanently lost (orphaned/hung dispatchTurn, dropped event stream, or a
// crash between HRC completion and the write). The turn is done; ACP just never
// noticed. Counting that terminal run as "launched" left the phantom pending
// forever, and `sameSessionHasActiveRun` then jammed the entire lane's input
// queue (T-04935: a media-ingest summary completed on HRC at 20:48 but its ACP
// run sat pending, blocking every later Discord message with a 300s
// "not dispatched" timeout). Filtering to an open run (no completedAt) lets the sweep
// reap the phantom while still protecting actively-processing turns.
export async function hasInFlightHrcRunSince(
  hrc: HrcRouteReader,
  hostSessionId: string,
  sinceIso: string,
  // Upper bound (exclusive) on `acceptedAt`. Without it, a run accepted at ANY
  // later time on the same host session counts as launch evidence — so an
  // UNRELATED turn dispatched hours later keeps a long-dead pending run alive,
  // and that phantom run blocks the whole lane's queue forever (T-04297 follow-up:
  // a 15:03 failed turn was kept "launched" by 17:18 e2e turns on the same host
  // session, jamming every subsequent Discord message into a non-draining queue).
  // Callers pass `createdAt + LAUNCH_CORRELATION_WINDOW_MS`: a genuine launch is
  // ACCEPTED by HRC within seconds of the ACP run being created, so a tight
  // window admits real launches while rejecting unrelated later activity.
  untilIso?: string
): Promise<boolean> {
  return hasInFlightRunMatching(hrc, { hostSessionId }, sinceIso, untilIso)
}

/**
 * Session-lineage variant of {@link hasInFlightHrcRunSince}. HRC can
 * auto-rotate a generation while accepting the dispatch, which moves the
 * in-flight run to a successor host session id. Scope+lane remain stable
 * across that rotation and are therefore the durable launch correlation key.
 *
 * The accepted-at window and non-terminal bound intentionally match the
 * host-session query: old unrelated turns must not protect a phantom ACP run,
 * and terminal HRC runs must not hide a lost ACP completion write-back.
 *
 * This read is keyed by scope, so HRC routes it to the scope's home and can
 * answer 503 session_home_unknown/unreachable; that is "do not know".
 */
export async function hasInFlightHrcRunForSessionSince(
  hrc: HrcRouteReader,
  sessionRef: { scopeRef: string; laneRef: string },
  sinceIso: string,
  untilIso?: string
): Promise<boolean> {
  return hasInFlightRunMatching(
    hrc,
    { scopeRef: sessionRef.scopeRef, laneRef: sessionRef.laneRef },
    sinceIso,
    untilIso
  )
}

/**
 * `GET /v1/runs` with acceptedSince/acceptedBefore/open (T-13244), then the
 * same conditions re-checked on every row. A row that fails the re-check
 * means the daemon ignored a selector, and a failed read means HRC cannot
 * say. Both answer "in flight": the stale sweep spares the run rather than
 * time it out on evidence it could not see.
 */
async function hasInFlightRunMatching(
  hrc: HrcRouteReader,
  identity: { hostSessionId: string } | { scopeRef: string; laneRef: string },
  sinceIso: string,
  untilIso: string | undefined
): Promise<boolean> {
  let rows: HrcRunRow[]
  try {
    rows = await hrc.readRuns({
      ...identity,
      acceptedSince: sinceIso,
      ...(untilIso !== undefined ? { acceptedBefore: untilIso } : {}),
      open: true,
      limit: 1,
    })
  } catch (error) {
    logUnknown('in_flight', identity, error)
    return true
  }
  if (rows.length === 0) return false
  if (rows.some((row) => !inFlightMatches(row, identity, sinceIso, untilIso))) {
    logUnknown('in_flight', identity, 'stray row')
  }
  return true
}

function inFlightMatches(
  row: HrcRunRow,
  identity: { hostSessionId: string } | { scopeRef: string; laneRef: string },
  sinceIso: string,
  untilIso: string | undefined
): boolean {
  return (
    identityMatches(row, identity) &&
    row.acceptedAt !== undefined &&
    row.completedAt === undefined &&
    row.acceptedAt >= sinceIso &&
    (untilIso === undefined || row.acceptedAt < untilIso)
  )
}

function identityMatches(
  row: HrcRunRow,
  identity: { hostSessionId: string } | { scopeRef: string; laneRef: string }
): boolean {
  return 'hostSessionId' in identity
    ? row.hostSessionId === identity.hostSessionId
    : row.scopeRef === identity.scopeRef && row.laneRef === identity.laneRef
}

function logUnknown(read: string, key: unknown, cause: unknown): void {
  writeLogLine({
    level: 'warn',
    component: 'acp-server',
    event: 'hrc.evidence.unknown',
    data: { read, key, cause: cause instanceof Error ? cause.message : String(cause) },
  })
}

export type RecentlyCompletedHrcRunEvidence = {
  runId: string
  acceptedAt: string
  completedAt: string
}

/**
 * The newest HRC run on the host session accepted inside the window and
 * completed since its start (`/v1/runs` acceptedSince/acceptedBefore/
 * completedSince, order=completedAt). `'unknown'` when the read failed or a
 * returned row fails the re-check (a daemon that ignored a selector or the
 * order): the terminal grace then protects without minting a marker.
 */
export async function hasRecentlyCompletedHrcRunSince(
  hrc: HrcRouteReader,
  hostSessionId: string,
  sinceIso: string,
  untilIso?: string
): Promise<RecentlyCompletedHrcRunEvidence | 'unknown' | undefined> {
  let rows: HrcRunRow[]
  try {
    rows = await hrc.readRuns({
      hostSessionId,
      acceptedSince: sinceIso,
      ...(untilIso !== undefined ? { acceptedBefore: untilIso } : {}),
      completedSince: sinceIso,
      order: 'completedAt',
      limit: 1,
    })
  } catch (error) {
    logUnknown('recently_completed', { hostSessionId }, error)
    return 'unknown'
  }
  const row = rows[0]
  if (row === undefined) return undefined
  if (
    rows.length > 1 ||
    row.hostSessionId !== hostSessionId ||
    row.acceptedAt === undefined ||
    row.completedAt === undefined ||
    row.acceptedAt < sinceIso ||
    (untilIso !== undefined && row.acceptedAt >= untilIso) ||
    row.completedAt < sinceIso
  ) {
    logUnknown('recently_completed', { hostSessionId }, 'stray row')
    return 'unknown'
  }
  return { runId: row.runId, acceptedAt: row.acceptedAt, completedAt: row.completedAt }
}

/** The run's status and error, from `GET /v1/runs?runId=`. Read failures propagate. */
export async function readRunStatus(
  hrc: HrcRouteReader,
  runId: string
): Promise<
  | {
      status: string
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  | undefined
> {
  const row = (await hrc.readRuns({ runId, limit: 1 })).find((run) => run.runId === runId)
  if (row === undefined) {
    return undefined
  }
  return {
    status: row.status,
    ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage !== undefined ? { errorMessage: row.errorMessage } : {}),
  }
}
