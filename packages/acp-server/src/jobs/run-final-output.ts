import type { LaneRef, SessionRef } from 'agent-scope'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { toCompletedVisibleAssistantMessage } from '../delivery/visible-assistant-messages.js'
import type { StoredRun } from '../domain/run-store.js'
import type { HrcRouteReader } from '../hrc-route-reader.js'
import {
  readAssistantMessageAfterSeq,
  readCompletedAssistantMessageFromHrcEvents,
  readLatestAssistantMessageSeq,
} from '../launcher-assistant-evidence.js'

// ---------------------------------------------------------------------------
// Dependencies — narrow interface so callers can inject fakes
// ---------------------------------------------------------------------------

export type RunFinalOutputDeps = {
  /**
   * Look up an ACP Run by its runId.  Must include hrcRunId / hostSessionId /
   * generation when present so we can route to the correct HRC event source.
   */
  getRun: (runId: string) => StoredRun | undefined

  /** HRC's read routes. */
  hrc: HrcRouteReader
}

// ---------------------------------------------------------------------------
// Overridable low-level readers (for testing)
// ---------------------------------------------------------------------------

export type HrcEventReaders = {
  /** Read the completed assistant message for a headless hrcRunId from HRC's events. */
  readCompletedAssistantMessageFromHrcEvents: (
    hrc: HrcRouteReader,
    runId: string
  ) => Promise<UnifiedSessionEvent | undefined>

  /** Read the latest assistant message sequence number for an interactive session. */
  readLatestAssistantMessageSeq: (
    hrc: HrcRouteReader,
    input: { hostSessionId: string; sessionRef: SessionRef }
  ) => Promise<number>

  /** Read the assistant message event after a given sequence number. */
  readAssistantMessageAfterSeq: (options: {
    hrc: HrcRouteReader
    hostSessionId: string
    sessionRef: SessionRef
    afterHrcSeq: number
  }) => Promise<UnifiedSessionEvent | undefined>
}

const defaultReaders: HrcEventReaders = {
  readCompletedAssistantMessageFromHrcEvents,
  readLatestAssistantMessageSeq,
  readAssistantMessageAfterSeq,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the final assistant text from an ACP Run's persisted HRC event log.
 *
 * Routes to the correct event source based on the Run record:
 *   - Headless runs (`hrcRunId` present): reads HRC's events keyed by run id.
 *   - Interactive/tmux runs (`hostSessionId` + `generation`): reads HRC's events
 *     keyed by host session, scope and lane.
 *
 * Returns `undefined` when no terminal assistant message exists yet (e.g. the
 * run is still in progress or produced no assistant output).
 */
export async function getRunFinalAssistantText(
  deps: RunFinalOutputDeps,
  runId: string,
  readers: HrcEventReaders = defaultReaders
): Promise<string | undefined> {
  const run = deps.getRun(runId)
  if (run === undefined) {
    return undefined
  }

  const event = await resolveAssistantEvent(deps.hrc, run, readers)
  if (event === undefined) {
    return undefined
  }

  const visible = toCompletedVisibleAssistantMessage(event)
  return visible?.text
}

// ---------------------------------------------------------------------------
// Internal routing
// ---------------------------------------------------------------------------

async function resolveAssistantEvent(
  hrc: HrcRouteReader,
  run: StoredRun,
  readers: HrcEventReaders
): Promise<UnifiedSessionEvent | undefined> {
  // Headless path: hrcRunId → canonical hrc_events table
  if (run.hrcRunId !== undefined) {
    return readers.readCompletedAssistantMessageFromHrcEvents(hrc, run.hrcRunId)
  }

  // Interactive/tmux path: hostSessionId + sessionRef → hrc_events table
  if (run.hostSessionId !== undefined) {
    const sessionRef: SessionRef = {
      scopeRef: run.scopeRef,
      laneRef: run.laneRef as LaneRef,
    }

    // Read the latest assistant message directly (seq 0 means "give me the latest")
    // We use afterHrcSeq: 0 to get the very first (and hopefully final) message,
    // but the correct approach is to read the latest seq then grab the message at that seq.
    const latestSeq = await readers.readLatestAssistantMessageSeq(hrc, {
      hostSessionId: run.hostSessionId,
      sessionRef,
    })

    if (latestSeq === 0) {
      return undefined
    }

    // Read the message at the latest seq (afterHrcSeq = latestSeq - 1 to get exactly that seq)
    return readers.readAssistantMessageAfterSeq({
      hrc,
      hostSessionId: run.hostSessionId,
      sessionRef,
      afterHrcSeq: latestSeq - 1,
    })
  }

  return undefined
}
