import type { LaneRef, SessionRef } from 'agent-scope'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { toCompletedVisibleAssistantMessage } from '../delivery/visible-assistant-messages.js'
import type { StoredRun } from '../domain/run-store.js'
import {
  type RawRunEventRecord,
  listRawRunEvents,
  readAssistantMessageAfterSeq,
  readLatestAssistantMessageSeq,
  toUnifiedAssistantMessageEndFromRawEvents,
} from '../real-launcher.js'

// ---------------------------------------------------------------------------
// Dependencies — narrow interface so callers can inject fakes
// ---------------------------------------------------------------------------

export type RunFinalOutputDeps = {
  /**
   * Look up an ACP Run by its runId.  Must include hrcRunId / hostSessionId /
   * generation when present so we can route to the correct HRC event source.
   */
  getRun: (runId: string) => StoredRun | undefined

  /** Filesystem path to the HRC SQLite database. */
  hrcDbPath: string
}

// ---------------------------------------------------------------------------
// Overridable low-level readers (for testing)
// ---------------------------------------------------------------------------

export type HrcEventReaders = {
  /** Return raw run events for a headless hrcRunId. */
  listRawRunEvents: (hrcDbPath: string, runId: string) => RawRunEventRecord[]

  /** Convert raw events → unified message_end event. */
  toUnifiedAssistantMessageEndFromRawEvents: (
    events: readonly RawRunEventRecord[]
  ) => UnifiedSessionEvent | undefined

  /** Read the latest assistant message sequence number for an interactive session. */
  readLatestAssistantMessageSeq: (
    hrcDbPath: string,
    input: { hostSessionId: string; sessionRef: SessionRef }
  ) => number

  /** Read the assistant message event after a given sequence number. */
  readAssistantMessageAfterSeq: (options: {
    hrcDbPath: string
    hostSessionId: string
    sessionRef: SessionRef
    afterHrcSeq: number
  }) => UnifiedSessionEvent | undefined
}

const defaultReaders: HrcEventReaders = {
  listRawRunEvents,
  toUnifiedAssistantMessageEndFromRawEvents,
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
 *   - Headless runs (`hrcRunId` present): reads `events` table keyed by run_id.
 *   - Interactive/tmux runs (`hostSessionId` + `generation`): reads `hrc_events`
 *     table keyed by host_session_id / scope_ref / lane_ref.
 *
 * Returns `undefined` when no terminal assistant message exists yet (e.g. the
 * run is still in progress or produced no assistant output).
 */
export function getRunFinalAssistantText(
  deps: RunFinalOutputDeps,
  runId: string,
  readers: HrcEventReaders = defaultReaders
): string | undefined {
  const run = deps.getRun(runId)
  if (run === undefined) {
    return undefined
  }

  const event = resolveAssistantEvent(deps.hrcDbPath, run, readers)
  if (event === undefined) {
    return undefined
  }

  const visible = toCompletedVisibleAssistantMessage(event)
  return visible?.text
}

// ---------------------------------------------------------------------------
// Internal routing
// ---------------------------------------------------------------------------

function resolveAssistantEvent(
  hrcDbPath: string,
  run: StoredRun,
  readers: HrcEventReaders
): UnifiedSessionEvent | undefined {
  // Headless path: hrcRunId → events table
  if (run.hrcRunId !== undefined) {
    const events = readers.listRawRunEvents(hrcDbPath, run.hrcRunId)
    return readers.toUnifiedAssistantMessageEndFromRawEvents(events)
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
    const latestSeq = readers.readLatestAssistantMessageSeq(hrcDbPath, {
      hostSessionId: run.hostSessionId,
      sessionRef,
    })

    if (latestSeq === 0) {
      return undefined
    }

    // Read the message at the latest seq (afterHrcSeq = latestSeq - 1 to get exactly that seq)
    return readers.readAssistantMessageAfterSeq({
      hrcDbPath,
      hostSessionId: run.hostSessionId,
      sessionRef,
      afterHrcSeq: latestSeq - 1,
    })
  }

  return undefined
}
