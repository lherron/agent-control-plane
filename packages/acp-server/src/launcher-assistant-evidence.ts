import type { SessionRef } from 'agent-scope'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import {
  type HrcEventRow,
  type HrcEventSelectors,
  type HrcRouteReader,
  eventMatches,
} from './hrc-route-reader.js'
import {
  assistantCompletionPayloadToUnifiedEvent,
  assistantMessagePayloadToUnifiedEvent,
} from './launcher-assistant-events.js'

const TAIL_PAGE = 100

/**
 * Session-keyed reads go to HRC by host session id, which answers locally;
 * a host session belongs to one scope and lane, so scope and lane are
 * re-checked on the rows rather than sent (a scope-keyed tail is
 * federation-routed). liveOnly is sent and re-checked: a retained history row
 * keeps its old ts under a fresh hrcSeq and is never current output.
 */
function sessionSelectors(
  input: { hostSessionId: string; sessionRef: SessionRef },
  eventKind: readonly string[]
): { wire: HrcEventSelectors; check: HrcEventSelectors } {
  const wire = { hostSessionId: input.hostSessionId, eventKind, liveOnly: true }
  return {
    wire,
    check: { ...wire, scopeRef: input.sessionRef.scopeRef, laneRef: input.sessionRef.laneRef },
  }
}

/**
 * The newest live `turn.message` hrcSeq on the session, the baseline a launch
 * arms above. Pages back past rows that fail the re-check, so a daemon that
 * ignores liveOnly still yields the live baseline. Read failures propagate:
 * arming at 0 would treat all ordinary history as new output.
 */
export async function readLatestAssistantMessageSeq(
  hrc: HrcRouteReader,
  input: {
    hostSessionId: string
    sessionRef: SessionRef
  }
): Promise<number> {
  const { wire, check } = sessionSelectors(input, ['turn.message'])
  let before: { beforeHrcSeq: number; ledgerIncarnationId: string } | undefined
  for (;;) {
    const page = await hrc.readEventTail({ ...wire, limit: TAIL_PAGE, ...(before ?? {}) })
    const live = page.events.filter((event) => eventMatches(event, check))
    if (live.length > 0) return Math.max(...live.map((event) => event.hrcSeq))
    const oldest = page.events[0]?.hrcSeq
    if (!page.truncated || oldest === undefined || page.ledgerIncarnationId === undefined) return 0
    before = { beforeHrcSeq: oldest, ledgerIncarnationId: page.ledgerIncarnationId }
  }
}

async function readSessionEventsAfter(
  hrc: HrcRouteReader,
  input: { hostSessionId: string; sessionRef: SessionRef; afterHrcSeq: number },
  eventKind: readonly string[]
): Promise<HrcEventRow[]> {
  const { wire, check } = sessionSelectors(input, eventKind)
  const rows = await hrc.readEvents({ ...wire, fromSeq: Math.max(1, input.afterHrcSeq + 1) })
  return rows.filter((event) => event.hrcSeq > input.afterHrcSeq && eventMatches(event, check))
}

export async function readAssistantMessageAfterSeq(options: {
  hrc: HrcRouteReader
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
}): Promise<UnifiedSessionEvent | undefined> {
  const rows = await readSessionEventsAfter(options.hrc, options, ['turn.message'])
  const row = rows[0]
  if (!row) {
    return undefined
  }

  return assistantMessagePayloadToUnifiedEvent(row.payload)
}

export async function readCompletedAssistantMessageAfterSeq(options: {
  hrc: HrcRouteReader
  hostSessionId: string
  sessionRef: SessionRef
  afterHrcSeq: number
}): Promise<UnifiedSessionEvent | undefined> {
  const rows = await readSessionEventsAfter(options.hrc, options, [
    'turn.message',
    'turn.completed',
  ])

  type Candidate = {
    hasAssistantMessage: boolean
    latestAssistantMessage?: UnifiedSessionEvent | undefined
    degradedCompletion?: UnifiedSessionEvent | undefined
    completed: boolean
  }
  const candidates = new Map<string, Candidate>()

  for (const row of rows) {
    const hrcRunId = row.runId?.trim()
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
      const event = assistantMessagePayloadToUnifiedEvent(row.payload)
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
    const completion = assistantCompletionPayloadToUnifiedEvent(row.payload)
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
}

/**
 * The completed assistant reply for a headless run, keyed by run id (no
 * evidence-origin filter, as the SQL had none). Read failures yield undefined.
 */
export async function readCompletedAssistantMessageFromHrcEvents(
  hrc: HrcRouteReader,
  runId: string
): Promise<UnifiedSessionEvent | undefined> {
  let rows: HrcEventRow[]
  try {
    rows = (await hrc.readEvents({ runId, eventKind: ['turn.message', 'turn.completed'] })).filter(
      (event) =>
        event.runId === runId &&
        (event.eventKind === 'turn.message' || event.eventKind === 'turn.completed')
    )
  } catch {
    return undefined
  }

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
    const event = assistantCompletionPayloadToUnifiedEvent(row.payload)
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
    const event = assistantMessagePayloadToUnifiedEvent(row.payload)
    if (event !== undefined) {
      return event
    }
  }

  return degradedCompletion
}
