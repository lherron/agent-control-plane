/**
 * `GET /v1/events` double for `acp task-timeline` tests (T-13243). Rows leave
 * it in the wire shape real calls against max3's HRC returned (camelCase,
 * null runId omitted, payload parsed); runId, scopeRef, laneRef, eventKind
 * (exact list) and the inclusive fromTs/toTs window filter as HRC T-13244 does.
 * `ignoreNewSelectors` drops fromTs/toTs, like a daemon without them.
 */
import type { HrcEventRow } from 'acp-server'
import type { HrcTimelineEventSource } from '../src/hrc-event-reader.js'

// [seq, ts, scopeRef, runId, eventKind, payloadJson]
export type HrcRow = [number, string, string, string | null, string, string]

export function hrcEventsFake(
  rows: readonly HrcRow[],
  options: { ignoreNewSelectors?: boolean } = {}
): HrcTimelineEventSource & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async readEvents(q) {
      calls.push(q)
      return rows
        .map(
          ([hrcSeq, ts, scopeRef, runId, eventKind, json]): HrcEventRow => ({
            hrcSeq,
            ts,
            scopeRef,
            laneRef: 'main',
            ...(runId !== null ? { runId } : {}),
            eventKind,
            payload: JSON.parse(json),
          })
        )
        .filter(
          (e) =>
            (q.runId === undefined || e.runId === q.runId) &&
            (q.scopeRef === undefined || e.scopeRef === q.scopeRef) &&
            (q.laneRef === undefined || e.laneRef === q.laneRef) &&
            (q.eventKind === undefined || q.eventKind.includes(e.eventKind)) &&
            (options.ignoreNewSelectors === true ||
              ((q.fromTs === undefined || e.ts >= q.fromTs) &&
                (q.toTs === undefined || e.ts <= q.toTs)))
        )
        .sort((a, b) => a.hrcSeq - b.hrcSeq)
    },
  }
}
