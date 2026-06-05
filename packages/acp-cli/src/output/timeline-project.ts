import type {
  ActorRef,
  EffectIntent,
  EvidenceRecord,
  ObligationRecord,
  WorkflowEvent,
  WorkflowTask,
} from 'acp-core'

import type { GetTaskResponse, WrkfRun } from '../http-client.js'

export type TimelineCategory =
  | 'transition'
  | 'evidence'
  | 'run'
  | 'mapping'
  | 'obligation'
  | 'effect'
  | 'anomaly'
  | 'meta'

export type TimelineKind =
  | 'accepted'
  | 'rejected'
  | 'recorded'
  | 'run'
  | 'mapping'
  | 'evidence'
  | 'obligation'
  | 'effect'
  | 'anomaly'

export type AcpTimelineRow = {
  ledger: 'acp'
  seq: number
  ts: string
  kind: TimelineKind
  category: TimelineCategory
  type: string
  actor?: ActorRef | undefined
  role?: string | undefined
  rejectionCode?: string | undefined
  versionDelta?: { from: number; to: number } | undefined
  scopeRef?: string | undefined
  participantRunId?: string | undefined
  refs: string[]
  payload?: unknown
  eventHash?: string | undefined
  prevHash?: string | undefined
}

export type HrcTimelineRow = {
  ledger: 'hrc'
  parentParticipantRunId: string
  hrcSeq?: number | undefined
  ts?: string | undefined
  eventKind: string
  label?: string | undefined
  displayText?: string | undefined
  toolName?: string | undefined
  assistantBody?: string | undefined
  payload?: Record<string, unknown> | undefined
  joinKind?: 'run_id' | 'scope_window' | 'event_window' | 'none' | undefined
  summary?:
    | {
        totalCount: number
        firstHrcSeq?: number | undefined
        lastHrcSeq?: number | undefined
        kindCounts: Record<string, number>
      }
    | undefined
  marker?: 'no_mapping' | 'no_events' | 'elided' | undefined
}

export type TimelineCollapsedRun = {
  parentParticipantRunId: string
  start: number
  end: number
  count: number
  toolName: string
}

export type TimelineRow = AcpTimelineRow | HrcTimelineRow

export type TaskTimelineProjection = {
  task: WorkflowTask
  summary: {
    eventCount: number
    rejectionCount: number
    firstEventAt?: string | undefined
    lastEventAt?: string | undefined
  }
  rows: TimelineRow[]
  warnings?: string[] | undefined
  collapsedRuns?: TimelineCollapsedRun[] | undefined
  hrcDetail?: 'summary' | 'events' | 'full' | undefined
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

function categoryFor(type: string): TimelineCategory {
  if (type.startsWith('transition.')) return 'transition'
  if (type.startsWith('evidence.')) return 'evidence'
  if (type.startsWith('participant_run.')) return 'run'
  if (type === 'workflow_hrc_run.mapped' || type.includes('hrc_run')) return 'mapping'
  if (type.startsWith('obligation.')) return 'obligation'
  if (type.startsWith('effect.')) return 'effect'
  if (type.startsWith('anomaly.')) return 'anomaly'
  return 'meta'
}

function kindFor(event: WorkflowEvent, category: TimelineCategory): TimelineKind {
  if (event.result === 'rejected') return 'rejected'
  if (category === 'run') return 'run'
  if (category === 'mapping') return 'mapping'
  if (category === 'evidence') return 'evidence'
  if (category === 'obligation') return 'obligation'
  if (category === 'effect') return 'effect'
  if (category === 'anomaly') return 'anomaly'
  return event.result === 'recorded' ? 'recorded' : 'accepted'
}

function refsFor(event: WorkflowEvent, response: GetTaskResponse): string[] {
  const payload = asRecord(event.payload)
  const refs = new Set<string>()
  const directFields = [
    'transitionId',
    'evidenceId',
    'evidenceKind',
    'kind',
    'ref',
    'runId',
    'hrcRunId',
    'obligationId',
    'effectId',
    'anomalyId',
  ]
  for (const field of directFields) {
    const value = stringField(payload, field)
    if (value !== undefined) refs.add(value)
  }

  if (event.participantRunId !== undefined) refs.add(event.participantRunId)
  if (event.runId !== undefined) refs.add(event.runId)
  if (event.supervisorRunId !== undefined) refs.add(event.supervisorRunId)

  for (const evidence of (response.evidence ?? []) as EvidenceRecord[]) {
    if (stringField(payload, 'evidenceId') === evidence.evidenceId) {
      refs.add(evidence.kind)
      refs.add(evidence.ref)
    }
  }
  for (const run of (response.runs ?? []) as WrkfRun[]) {
    if (run.id === event.participantRunId || run.id === stringField(payload, 'runId')) {
      refs.add(run.id)
      if (run.externalRunRef !== undefined) refs.add(run.externalRunRef)
      const delivery = parseDeliveryRef(run.deliveryRef)
      if (delivery?.scopeRef !== undefined) refs.add(`scope:${delivery.scopeRef}`)
    }
  }
  for (const obligation of (response.obligations ?? []) as ObligationRecord[]) {
    if (obligation.obligationId === stringField(payload, 'obligationId')) {
      refs.add(obligation.kind)
    }
  }
  for (const effect of (response.effects ?? []) as EffectIntent[]) {
    if (effect.effectId === stringField(payload, 'effectId')) {
      refs.add(effect.kind)
    }
  }

  return [...refs]
}

function versionDeltaFor(event: WorkflowEvent): { from: number; to: number } | undefined {
  if (event.nextTaskVersion === undefined) {
    return undefined
  }
  if (event.nextTaskVersion === event.observedTaskVersion) {
    return undefined
  }
  return { from: event.observedTaskVersion, to: event.nextTaskVersion }
}

function parseDeliveryRef(
  ref: string | undefined
): { scopeRef?: string | undefined; laneRef?: string | undefined } | undefined {
  if (ref === undefined || ref.length === 0) return undefined
  try {
    const parsed = JSON.parse(ref) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined
    }
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['scopeRef'] === 'string' ? { scopeRef: record['scopeRef'] } : {}),
      ...(typeof record['laneRef'] === 'string' ? { laneRef: record['laneRef'] } : {}),
    }
  } catch {
    return undefined
  }
}

function scopeFor(event: WorkflowEvent, runs: readonly WrkfRun[]): string | undefined {
  const payload = asRecord(event.payload)
  const payloadScope = stringField(payload, 'scopeRef')
  if (payloadScope !== undefined) {
    return payloadScope
  }
  const hrcRunId = stringField(payload, 'hrcRunId')
  const run = runs.find(
    (entry) =>
      entry.externalRunRef === hrcRunId ||
      entry.id === event.participantRunId ||
      entry.id === stringField(payload, 'runId')
  )
  return parseDeliveryRef(run?.deliveryRef)?.scopeRef
}

export function projectTaskTimeline(response: GetTaskResponse): TaskTimelineProjection {
  const rows = response.timeline
    .map((event) => {
      const category = categoryFor(event.type)
      const scopeRef = scopeFor(event, response.runs ?? [])
      return {
        seq: event.workflowSeq,
        ts: event.createdAt,
        kind: kindFor(event, category),
        category,
        type: event.type,
        actor: event.actor,
        ...(event.role !== undefined ? { role: event.role } : {}),
        ...(event.rejectionCode !== undefined ? { rejectionCode: event.rejectionCode } : {}),
        ...(versionDeltaFor(event) !== undefined ? { versionDelta: versionDeltaFor(event) } : {}),
        ...(scopeRef !== undefined ? { scopeRef } : {}),
        ...(event.participantRunId !== undefined
          ? { participantRunId: event.participantRunId }
          : {}),
        refs: refsFor(event, response),
        payload: event.payload,
        eventHash: event.eventHash,
        ...(event.prevHash !== undefined ? { prevHash: event.prevHash } : {}),
        ledger: 'acp',
      } satisfies AcpTimelineRow
    })
    .sort((left, right) => left.seq - right.seq || left.ts.localeCompare(right.ts))

  const firstEventAt = rows[0]?.ts
  const lastEventAt = rows.at(-1)?.ts
  return {
    task: response.task,
    summary: {
      eventCount: rows.length,
      rejectionCount: rows.filter((row) => row.kind === 'rejected').length,
      ...(firstEventAt !== undefined ? { firstEventAt } : {}),
      ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    },
    rows,
  }
}

export function timelineEventMatchesSearchText(row: TimelineRow, searchText: string): boolean {
  if (row.ledger === 'hrc') {
    const haystack = [
      row.eventKind,
      row.label,
      row.marker,
      row.parentParticipantRunId,
      JSON.stringify(row.payload ?? {}),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(searchText.toLowerCase())
  }
  const haystack = [
    row.type,
    row.actor?.id,
    row.role,
    row.rejectionCode,
    row.scopeRef,
    ...row.refs,
    JSON.stringify(row.payload ?? {}),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(searchText.toLowerCase())
}
