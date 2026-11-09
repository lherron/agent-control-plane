import { Database } from 'bun:sqlite'
import type { SessionRef } from 'agent-scope'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import { readHrcEvidence } from './hrc-evidence-origin.js'
import {
  assistantCompletionPayloadToUnifiedEvent,
  assistantMessagePayloadToUnifiedEvent,
} from './launcher-assistant-events.js'

export function readLatestAssistantMessageSeq(
  hrcDbPath: string,
  input: {
    hostSessionId: string
    sessionRef: SessionRef
  }
): number {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    // Schema and SQLite errors propagate: arming a launch at 0 would treat all
    // ordinary history as new output. An empty table still yields 0.
    const row = readHrcEvidence(db, (actuatingClause) =>
      db
        .query<{ hrcSeq: number | null }, [string, string, string]>(
          `SELECT MAX(hrc_seq) AS hrcSeq
            FROM hrc_events
            WHERE host_session_id = ?
              AND scope_ref = ?
              AND lane_ref = ?
              AND event_kind = 'turn.message'
              ${actuatingClause}`
        )
        .get(input.hostSessionId, input.sessionRef.scopeRef, input.sessionRef.laneRef)
    )
    return row?.hrcSeq ?? 0
  } finally {
    db.close()
  }
}

export function readAssistantMessageAfterSeq(options: {
  hrcDbPath: string
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
}): UnifiedSessionEvent | undefined {
  const db = new Database(options.hrcDbPath, { readonly: true })
  try {
    const row = readHrcEvidence(db, (actuatingClause) =>
      db
        .query<{ hrcSeq: number; payloadJson: string }, [string, string, string, number]>(
          `SELECT hrc_seq AS hrcSeq, payload_json AS payloadJson
            FROM hrc_events
            WHERE host_session_id = ?
              AND scope_ref = ?
              AND lane_ref = ?
              AND event_kind = 'turn.message'
              AND hrc_seq > ?
              ${actuatingClause}
            ORDER BY hrc_seq ASC
            LIMIT 1`
        )
        .get(
          options.hostSessionId,
          options.sessionRef.scopeRef,
          options.sessionRef.laneRef,
          options.afterHrcSeq
        )
    )
    if (!row) {
      return undefined
    }

    return assistantMessagePayloadToUnifiedEvent(parseJson(row.payloadJson))
  } finally {
    db.close()
  }
}

export function readCompletedAssistantMessageAfterSeq(options: {
  hrcDbPath: string
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
}): UnifiedSessionEvent | undefined {
  const db = new Database(options.hrcDbPath, { readonly: true })
  try {
    const rows = readHrcEvidence(db, (actuatingClause) =>
      db
        .query<
          { eventKind: string; hrcRunId: string | null; payloadJson: string },
          [string, string, string, number]
        >(
          `SELECT event_kind AS eventKind, run_id AS hrcRunId, payload_json AS payloadJson
            FROM hrc_events
            WHERE host_session_id = ?
              AND scope_ref = ?
              AND lane_ref = ?
              AND event_kind IN ('turn.message', 'turn.completed')
              AND hrc_seq > ?
              ${actuatingClause}
            ORDER BY hrc_seq ASC`
        )
        .all(
          options.hostSessionId,
          options.sessionRef.scopeRef,
          options.sessionRef.laneRef,
          options.afterHrcSeq
        )
    )

    type Candidate = {
      hasAssistantMessage: boolean
      latestAssistantMessage?: UnifiedSessionEvent | undefined
      degradedCompletion?: UnifiedSessionEvent | undefined
      completed: boolean
    }
    const candidates = new Map<string, Candidate>()

    for (const row of rows) {
      const hrcRunId = row.hrcRunId?.trim()
      if (!hrcRunId) {
        continue
      }
      const candidate =
        candidates.get(hrcRunId) ??
        ({
          hasAssistantMessage: false,
          completed: false,
        } satisfies Candidate)

      if (row.eventKind === 'turn.message') {
        const event = assistantMessagePayloadToUnifiedEvent(parseJson(row.payloadJson))
        if (event !== undefined) {
          candidate.hasAssistantMessage = true
          candidate.latestAssistantMessage = event
          candidates.set(hrcRunId, candidate)
        }
        continue
      }

      if (!candidate.hasAssistantMessage) {
        continue
      }
      candidate.completed = true
      const completion = assistantCompletionPayloadToUnifiedEvent(parseJson(row.payloadJson))
      if (completion !== undefined) {
        if (completion.type === 'message_end') {
          candidate.latestAssistantMessage = completion
        } else if (candidate.degradedCompletion === undefined) {
          candidate.degradedCompletion = completion
        }
      }
      candidates.set(hrcRunId, candidate)
    }

    for (const candidate of candidates.values()) {
      if (!candidate.completed) {
        continue
      }
      return candidate.latestAssistantMessage ?? candidate.degradedCompletion
    }

    return undefined
  } finally {
    db.close()
  }
}

export function readCompletedAssistantMessageFromHrcEvents(
  hrcDbPath: string,
  runId: string
): UnifiedSessionEvent | undefined {
  const db = new Database(hrcDbPath, { readonly: true })
  try {
    const rows = db
      .query<{ eventKind: string; payloadJson: string }, [string]>(
        `SELECT event_kind AS eventKind, payload_json AS payloadJson
          FROM hrc_events
          WHERE run_id = ?
            AND event_kind IN ('turn.message', 'turn.completed')
          ORDER BY hrc_seq ASC`
      )
      .all(runId)

    // Prefer real assistant content. A content-less synthesized completion
    // (e.g. source: "launch_exit_synthesized" emitted when a headless Codex
    // launch exits without the driver observing a turn-completed marker) maps
    // to a degraded turn_end. If we returned that immediately it would shadow
    // the real reply, which headless Codex delivers as a turn.message. So we
    // only fall back to the degraded outcome when no real assistant content
    // exists anywhere in the run.
    let degradedCompletion: UnifiedSessionEvent | undefined

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.eventKind !== 'turn.completed') {
        continue
      }
      const event = assistantCompletionPayloadToUnifiedEvent(parseJson(row.payloadJson))
      if (event === undefined) {
        continue
      }
      if (event.type === 'message_end') {
        return event
      }
      // Degraded turn_end (no assistant content) — keep the newest as a
      // fallback, but let a real turn.message win first.
      if (degradedCompletion === undefined) {
        degradedCompletion = event
      }
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.eventKind !== 'turn.message') {
        continue
      }
      const event = assistantMessagePayloadToUnifiedEvent(parseJson(row.payloadJson))
      if (event !== undefined) {
        return event
      }
    }

    return degradedCompletion
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
