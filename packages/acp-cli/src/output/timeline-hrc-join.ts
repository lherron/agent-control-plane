import type { WorkflowHrcRunMap } from 'acp-core'

import type { HrcEvent, HrcStoreReader } from '../hrc-store-reader.js'
import type { GetTaskResponse } from '../http-client.js'
import { hrcEventToTimelineRow } from './hrc-event-to-row.js'
import type {
  AcpTimelineRow,
  HrcTimelineRow,
  TaskTimelineProjection,
  TimelineCollapsedRun,
  TimelineRow,
} from './timeline-project.js'

export type HrcDetailMode = 'summary' | 'events' | 'full'
export type HrcAnchorMode = 'runs' | 'events' | 'both' | 'auto'

export type HrcJoinOptions = {
  reader: HrcStoreReader
  response: GetTaskResponse
  detail: HrcDetailMode
  anchorMode?: HrcAnchorMode | undefined
  eventWindowSeconds?: number | undefined
  kinds?: Set<string> | undefined
  allKinds?: boolean | undefined
}

type HrcJoinBlock = {
  participantRunId: string
  joinKind: NonNullable<HrcTimelineRow['joinKind']>
  events: HrcEvent[]
  totalCount: number
  warning?: string | undefined
  marker?: 'no_mapping' | 'no_events' | undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function runIdFor(row: AcpTimelineRow): string | undefined {
  return row.participantRunId ?? stringField(asRecord(row.payload), 'runId')
}

function participantCompleteTs(response: GetTaskResponse, runId: string): string | undefined {
  const typedRuns = response.participantRuns as
    | Array<{ runId?: string; completedAt?: string }>
    | undefined
  return typedRuns?.find((run) => run.runId === runId)?.completedAt
}

function nowIso(): string {
  return new Date().toISOString()
}

function addSeconds(ts: string, seconds: number): string {
  const millis = new Date(ts).getTime()
  if (!Number.isFinite(millis)) return ts
  return new Date(millis + seconds * 1000).toISOString()
}

function summarize(events: readonly HrcEvent[], totalCount: number): HrcTimelineRow['summary'] {
  const kindCounts: Record<string, number> = {}
  for (const event of events) {
    kindCounts[event.eventKind] = (kindCounts[event.eventKind] ?? 0) + 1
  }
  return {
    totalCount,
    ...(events[0]?.hrcSeq !== undefined ? { firstHrcSeq: events[0].hrcSeq } : {}),
    ...(events.at(-1)?.hrcSeq !== undefined ? { lastHrcSeq: events.at(-1)?.hrcSeq } : {}),
    kindCounts,
  }
}

function hrcRowsForBlock(block: HrcJoinBlock, detail: HrcDetailMode): HrcTimelineRow[] {
  if (block.marker !== undefined) {
    return [
      {
        ledger: 'hrc',
        parentParticipantRunId: block.participantRunId,
        eventKind: 'hrc',
        marker: block.marker,
        joinKind: block.joinKind,
      },
    ]
  }

  if (detail === 'summary') {
    return [
      {
        ledger: 'hrc',
        parentParticipantRunId: block.participantRunId,
        eventKind: 'hrc.summary',
        joinKind: block.joinKind,
        summary: summarize(block.events, block.totalCount),
      },
    ]
  }

  const rows: HrcTimelineRow[] = block.events.map((event) =>
    hrcEventToTimelineRow({
      event,
      parentParticipantRunId: block.participantRunId,
      joinKind: block.joinKind,
      detail,
    })
  )

  if (block.totalCount > block.events.length) {
    const elided = Math.max(0, block.totalCount - block.events.length)
    rows.splice(250, 0, {
      ledger: 'hrc',
      parentParticipantRunId: block.participantRunId,
      eventKind: 'hrc.elided',
      label: `${elided} events elided; use --hrc-detail summary for counts`,
      joinKind: block.joinKind,
      marker: 'elided',
    })
  }
  return rows
}

function findMap(
  maps: readonly WorkflowHrcRunMap[],
  participantRunId: string
): WorkflowHrcRunMap | undefined {
  return maps.find((map) => map.participantRunId === participantRunId)
}

function fetchBlockForRun(
  row: AcpTimelineRow,
  map: WorkflowHrcRunMap | undefined,
  options: HrcJoinOptions
): HrcJoinBlock {
  const participantRunId = runIdFor(row) ?? 'unknown'
  if (map === undefined) {
    return {
      participantRunId,
      joinKind: 'none',
      events: [],
      totalCount: 0,
      marker: 'no_mapping',
    }
  }

  const commonQuery = {
    fromTs: row.ts,
    toTs: participantCompleteTs(options.response, participantRunId) ?? nowIso(),
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
    ...(options.allKinds === true ? { allKinds: true } : {}),
  }

  const primary = options.reader.fetchByRunId({
    ...commonQuery,
    hrcRunId: map.hrcRunId,
    ...(map.scopeRef !== undefined ? { scopeRef: map.scopeRef } : {}),
    ...(map.laneRef !== undefined ? { laneRef: map.laneRef } : {}),
  })
  if (primary.totalCount > 0) {
    return {
      participantRunId,
      joinKind: 'run_id',
      events: primary.events,
      totalCount: primary.totalCount,
    }
  }

  const fallback = options.reader.fetchByScopeWindow({
    ...commonQuery,
    ...(map.scopeRef !== undefined ? { scopeRef: map.scopeRef } : {}),
    laneRef: map.laneRef ?? 'main',
  })
  if (fallback.totalCount > 0) {
    return {
      participantRunId,
      joinKind: 'scope_window',
      events: fallback.events,
      totalCount: fallback.totalCount,
      warning: `hrc_join_fallback:${participantRunId}:scope+window`,
    }
  }

  return {
    participantRunId,
    joinKind: map.hrcRunId.length > 0 ? 'run_id' : 'scope_window',
    events: [],
    totalCount: 0,
    marker: 'no_events',
  }
}

function scopeRefForActorEvent(row: AcpTimelineRow, response: GetTaskResponse): string | undefined {
  const actorId = row.actor?.id
  if (actorId === undefined || actorId.length === 0) return undefined
  return `agent:${actorId}:project:${response.task.projectId}`
}

function fetchBlockForEvent(
  row: AcpTimelineRow,
  options: HrcJoinOptions
): HrcJoinBlock | undefined {
  const scopeRef = scopeRefForActorEvent(row, options.response)
  if (scopeRef === undefined) return undefined
  const result = options.reader.fetchByScopeWindow({
    scopeRef,
    laneRef: 'main',
    fromTs: addSeconds(row.ts, -5),
    toTs: addSeconds(row.ts, options.eventWindowSeconds ?? 30),
    ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
    ...(options.allKinds === true ? { allKinds: true } : {}),
  })

  return {
    participantRunId: `event:${row.seq}`,
    joinKind: 'event_window',
    events: result.events,
    totalCount: result.totalCount,
    ...(result.totalCount === 0 ? { marker: 'no_events' as const } : {}),
  }
}

function isParticipantRunLaunch(row: TimelineRow): row is AcpTimelineRow {
  return row.ledger === 'acp' && row.category === 'run' && row.type === 'participant_run.launched'
}

function hasParticipantRunLaunch(rows: readonly TimelineRow[]): boolean {
  return rows.some(isParticipantRunLaunch)
}

function resolvedAnchors(
  rows: readonly TimelineRow[],
  mode: HrcAnchorMode | undefined
): { runs: boolean; events: boolean } {
  const selected = mode ?? 'auto'
  if (selected === 'runs') return { runs: true, events: false }
  if (selected === 'events') return { runs: false, events: true }
  if (selected === 'both') return { runs: true, events: true }
  return hasParticipantRunLaunch(rows)
    ? { runs: true, events: false }
    : { runs: false, events: true }
}

function isCollapsibleToolRow(row: TimelineRow): row is HrcTimelineRow {
  return (
    row.ledger === 'hrc' &&
    row.toolName !== undefined &&
    (row.eventKind === 'tool_execution_start' ||
      row.eventKind === 'tool_execution_end' ||
      row.eventKind === 'codex.tool_result')
  )
}

export function detectCollapsedHrcRuns(rows: readonly TimelineRow[]): TimelineCollapsedRun[] {
  const collapsed: TimelineCollapsedRun[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row === undefined) {
      index += 1
      continue
    }
    if (!isCollapsibleToolRow(row)) {
      index += 1
      continue
    }
    const toolName = row.toolName
    if (toolName === undefined) {
      index += 1
      continue
    }
    const parentParticipantRunId = row.parentParticipantRunId
    let endExclusive = index + 1
    while (endExclusive < rows.length) {
      const next = rows[endExclusive]
      if (
        next === undefined ||
        !isCollapsibleToolRow(next) ||
        next.toolName !== toolName ||
        next.parentParticipantRunId !== parentParticipantRunId
      ) {
        break
      }
      endExclusive += 1
    }
    const length = endExclusive - index
    if (length > 3) {
      collapsed.push({
        parentParticipantRunId,
        start: index + 3,
        end: endExclusive - 1,
        count: length - 3,
        toolName,
      })
    }
    index = endExclusive
  }
  return collapsed
}

export function joinHrcTimeline(
  projection: TaskTimelineProjection,
  options: HrcJoinOptions
): TaskTimelineProjection {
  const maps = options.response.workflowHrcRunMaps ?? []
  const rows: TimelineRow[] = []
  const warnings = new Set(projection.warnings ?? [])
  const anchors = resolvedAnchors(projection.rows, options.anchorMode)
  const seenHrcEvents = new Set<string>()

  const appendBlock = (block: HrcJoinBlock): void => {
    const filteredEvents = block.events.filter((event) => {
      const key = `${event.scopeRef ?? ''}:${event.hrcSeq}`
      if (seenHrcEvents.has(key)) return false
      seenHrcEvents.add(key)
      return true
    })
    const dedupedBlock: HrcJoinBlock = {
      ...block,
      events: filteredEvents,
      totalCount:
        filteredEvents.length === block.events.length
          ? block.totalCount
          : Math.min(block.totalCount, filteredEvents.length),
      ...(filteredEvents.length === 0 && block.marker === undefined
        ? { marker: 'no_events' as const }
        : {}),
    }
    if (dedupedBlock.warning !== undefined) warnings.add(dedupedBlock.warning)
    rows.push(...hrcRowsForBlock(dedupedBlock, options.detail))
  }

  for (const row of projection.rows) {
    rows.push(row)

    if (anchors.runs && isParticipantRunLaunch(row)) {
      const participantRunId = runIdFor(row)
      if (participantRunId !== undefined) {
        appendBlock(fetchBlockForRun(row, findMap(maps, participantRunId), options))
      }
    }

    if (anchors.events && row.ledger === 'acp' && row.actor !== undefined) {
      const block = fetchBlockForEvent(row, options)
      if (block !== undefined) appendBlock(block)
    }
  }

  return {
    ...projection,
    rows,
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
    ...(options.detail !== 'summary' ? { collapsedRuns: detectCollapsedHrcRuns(rows) } : {}),
    hrcDetail: options.detail,
  }
}
