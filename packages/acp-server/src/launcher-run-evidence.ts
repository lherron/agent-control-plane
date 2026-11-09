import { Database } from 'bun:sqlite'

export function findLaunchIdForRun(hrcDbPath: string, runId: string): string | undefined {
  let db: Database | undefined
  try {
    db = new Database(hrcDbPath, { readonly: true })
    const row = db
      .query<{ launchId: string }, [string]>(
        `SELECT launch_id AS launchId
           FROM hrc_events
          WHERE run_id = ? AND launch_id IS NOT NULL
          ORDER BY hrc_seq ASC
          LIMIT 1`
      )
      .get(runId)
    return row?.launchId
  } catch {
    return undefined
  } finally {
    db?.close()
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
// "not dispatched" timeout). Filtering to `completed_at IS NULL` lets the sweep
// reap the phantom while still protecting actively-processing turns.
export function hasInFlightHrcRunSince(
  hrcDbPath: string,
  hostSessionId: string,
  sinceIso: string,
  // Upper bound (exclusive) on `accepted_at`. Without it, a run accepted at ANY
  // later time on the same host session counts as launch evidence — so an
  // UNRELATED turn dispatched hours later keeps a long-dead pending run alive,
  // and that phantom run blocks the whole lane's queue forever (T-04297 follow-up:
  // a 15:03 failed turn was kept "launched" by 17:18 e2e turns on the same host
  // session, jamming every subsequent Discord message into a non-draining queue).
  // Callers pass `createdAt + LAUNCH_CORRELATION_WINDOW_MS`: a genuine launch is
  // ACCEPTED by HRC within seconds of the ACP run being created, so a tight
  // window admits real launches while rejecting unrelated later activity.
  untilIso?: string
): boolean {
  return hasInFlightRunMatching(hrcDbPath, { hostSessionId }, sinceIso, untilIso)
}

/**
 * Session-lineage variant of {@link hasInFlightHrcRunSince}. HRC can
 * auto-rotate a generation while accepting the dispatch, which moves the
 * in-flight run to a successor host_session_id. Scope+lane remain stable
 * across that rotation and are therefore the durable launch correlation key.
 *
 * The accepted-at window and non-terminal bound intentionally match the
 * host-session query: old unrelated turns must not protect a phantom ACP run,
 * and terminal HRC runs must not hide a lost ACP completion write-back.
 */
export function hasInFlightHrcRunForSessionSince(
  hrcDbPath: string,
  sessionRef: { scopeRef: string; laneRef: string },
  sinceIso: string,
  untilIso?: string
): boolean {
  return hasInFlightRunMatching(
    hrcDbPath,
    { scopeRef: sessionRef.scopeRef, laneRef: sessionRef.laneRef },
    sinceIso,
    untilIso
  )
}

function hasInFlightRunMatching(
  hrcDbPath: string,
  identity: { hostSessionId: string } | { scopeRef: string; laneRef: string },
  sinceIso: string,
  untilIso: string | undefined
): boolean {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const byHost = 'hostSessionId' in identity
    const predicate = byHost ? 'host_session_id = ?' : 'scope_ref = ? AND lane_ref = ?'
    const values = byHost ? [identity.hostSessionId] : [identity.scopeRef, identity.laneRef]
    const row = db
      .query<{ runId: string }, string[]>(
        `SELECT run_id AS runId
           FROM runs
          WHERE ${predicate}
            AND accepted_at IS NOT NULL
            AND completed_at IS NULL
            AND accepted_at >= ?
            ${untilIso === undefined ? '' : 'AND accepted_at < ?'}
          LIMIT 1`
      )
      .get(...values, sinceIso, ...(untilIso === undefined ? [] : [untilIso]))
    return row !== null && row !== undefined
  } catch {
    return false
  } finally {
    db.close()
  }
}

export type RecentlyCompletedHrcRunEvidence = {
  runId: string
  acceptedAt: string
  completedAt: string
}

export function hasRecentlyCompletedHrcRunSince(
  hrcDbPath: string,
  hostSessionId: string,
  sinceIso: string,
  untilIso?: string
): RecentlyCompletedHrcRunEvidence | undefined {
  let db: Database | undefined
  try {
    db = new Database(hrcDbPath, { readonly: true })
    const row = db
      .query<RecentlyCompletedHrcRunEvidence, string[]>(
        `SELECT run_id AS runId,
                accepted_at AS acceptedAt,
                completed_at AS completedAt
           FROM runs
          WHERE host_session_id = ?
            AND accepted_at IS NOT NULL
            AND completed_at IS NOT NULL
            AND accepted_at >= ?
            ${untilIso === undefined ? '' : 'AND accepted_at < ?'}
            AND completed_at >= ?
          ORDER BY completed_at DESC, run_id DESC
          LIMIT 1`
      )
      .get(hostSessionId, sinceIso, ...(untilIso === undefined ? [] : [untilIso]), sinceIso)
    return row ?? undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

export function readRunStatus(
  hrcDbPath: string,
  runId: string
):
  | {
      status: string
      errorCode?: string | undefined
      errorMessage?: string | undefined
    }
  | undefined {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const row = db
      .query<
        {
          status: string
          errorCode: string | null
          errorMessage: string | null
        },
        [string]
      >(
        `SELECT status, error_code AS errorCode, error_message AS errorMessage
          FROM runs
          WHERE run_id = ?`
      )
      .get(runId)
    if (!row) {
      return undefined
    }
    return {
      status: row.status,
      ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    }
  } finally {
    db.close()
  }
}
