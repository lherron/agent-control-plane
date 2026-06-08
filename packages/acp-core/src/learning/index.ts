import { hashValue, stableJson } from '../internal/canonical-json.js'
import type { ActorRef, WorkflowEvent, WorkflowKernelSnapshot } from '../workflow/index.js'

const SHORT_HASH_START = 7
const SHORT_HASH_END = 19

/** Strip the `sha256:` prefix and take the 12-char short id. */
function shortHashId(hash: string): string {
  return hash.slice(SHORT_HASH_START, SHORT_HASH_END)
}

export type CorrelationState =
  | 'fully_correlated'
  | 'partially_correlated'
  | 'inferred_correlation'
  | 'malformed'
  | 'quarantined'

export type WorkflowTrace = {
  traceId: string
  workflowTaskId: string
  workflow: { id: string; version: number; hash: string }
  workflowSeqRange: [number, number]
  hrcRanges: Array<{
    hrcRunId: string
    startSeq: number
    endSeq: number
    correlationState: 'direct' | 'derived' | 'inferred'
  }>
  initialProjectionHash: string
  finalProjectionHash: string
  outcome: {
    phase?: string | undefined
    closed: boolean
    result?: 'success' | 'failure' | 'abandoned' | 'inconclusive' | undefined
    humanOverride: boolean
  }
  metrics: {
    transitionsAccepted: number
    transitionsRejected: number
    supervisorActionsAccepted: number
    supervisorActionsRejected: number
    evidenceAttached: number
    evidenceRejected: number
    obligationsCreated: number
    obligationsWaived: number
    anomaliesRecorded: number
    participantRuns: number
    hrcToolCalls: number
    hrcToolErrors: number
    wallMs: number
  }
  correlation: {
    state: CorrelationState
    missingKeys: string[]
    warnings: string[]
  }
}

export type TraceIngestReport = {
  traceId: string
  workflowTaskId: string
  correlationState: CorrelationState
  missingKeys: string[]
  conflictingKeys: string[]
  hrcRanges: Array<{ hrcRunId: string; startSeq: number; endSeq: number }>
  workflowSeqRange: [number, number]
  warnings: string[]
}

export type TraceUseLabel = {
  traceId: string
  use: 'usable_for_replay' | 'usable_for_regression' | 'usable_for_diagnosis' | 'quarantined'
  source: 'kernel' | 'human' | 'external_evaluator' | 'learner_proposed'
  confidence?: number | undefined
  reason: string
  reviewedBy?: ActorRef | undefined
  sourceEventIds: string[]
  createdAt: string
}

export type LearningArtifactBase = {
  artifactId: string
  artifactKind: string
  authorityTier: 1 | 2 | 3
  lifecycle: 'draft' | 'accepted' | 'active' | 'stale' | 'archived' | 'pinned' | 'quarantined'
  origin:
    | 'human_directed'
    | 'background_review'
    | 'kernel'
    | 'external_evaluator'
    | 'curator'
    | 'learner_proposed'
    | 'promotion_authority'
  sourceTraceIds: string[]
  sourceEventIds: string[]
  createdBy: ActorRef
  createdAt: string
  updatedAt: string
}

export type PatchBundle = {
  patchBundleId: string
  title: string
  hypothesis: string
  sourceTraceIds: string[]
  sourceEventIds: string[]
  facets: Record<string, unknown>
  risk: {
    changesAuthority: boolean
    weakensRequirement: boolean
    expandsCapability: boolean
    changesEvaluator: boolean
    changesTaskTaxonomy: boolean
    suppressesOrReclassifiesAnomalies: boolean
  }
  evalPlan: {
    replayTraceIds: string[]
    regressionSuiteIds: string[]
    counterfactualSuiteIds: string[]
    requiredInvariants: string[]
    operationalMetrics?: string[] | undefined
  }
  rollbackPlan: string
  author: ActorRef
  createdAt: string
}

export type ReplayReport = {
  reportId: string
  patchBundleId?: string | undefined
  evaluatorVersion: string
  replayTraceIds: string[]
  results: Array<{
    traceId: string
    outcome: 'passed' | 'failed' | 'inconclusive'
    failedProperties: string[]
    diffSummary?: string | undefined
  }>
  createdAt: string
}

export type PromotionReadinessReport = {
  reportId: string
  patchBundleId: string
  replayReportIds: string[]
  evalReportIds: string[]
  riskSummary: string
  requiredAuthorities: string[]
  unmetRequirements: string[]
  recommendation: 'reject' | 'request_more_evidence' | 'stage' | 'canary' | 'promote'
  rationale: string
  createdAt: string
}

function eventHashInput(event: WorkflowEvent): Omit<WorkflowEvent, 'eventHash'> {
  const { eventHash: _eventHash, ...rest } = event
  return rest
}

function count(events: readonly WorkflowEvent[], predicate: (event: WorkflowEvent) => boolean) {
  return events.filter(predicate).length
}

export function materializeWorkflowTrace(input: {
  snapshot: WorkflowKernelSnapshot
  workflowTaskId: string
  hrcEventStats?: Record<
    string,
    { toolCalls?: number | undefined; toolErrors?: number | undefined }
  >
  now?: string | undefined
}): { trace: WorkflowTrace; ingestReport: TraceIngestReport } {
  const task = input.snapshot.tasks.find((candidate) => candidate.taskId === input.workflowTaskId)
  if (task === undefined) {
    throw new Error(`workflow task not found: ${input.workflowTaskId}`)
  }
  const events = input.snapshot.events
    .filter((event) => event.taskId === input.workflowTaskId)
    .sort((left, right) => left.workflowSeq - right.workflowSeq)
  const maps = (input.snapshot.workflowHrcRunMaps ?? []).filter(
    (map) => map.workflowTaskId === input.workflowTaskId
  )
  const missingKeys: string[] = []
  if (events.length === 0) {
    missingKeys.push('workflow_events')
  }
  if (maps.length === 0) {
    missingKeys.push('workflow_hrc_run_map')
  }

  const correlationState: CorrelationState =
    missingKeys.length === 0
      ? 'fully_correlated'
      : events.length > 0
        ? 'partially_correlated'
        : 'malformed'
  const hrcRanges = maps.map((map) => ({
    hrcRunId: map.hrcRunId,
    startSeq: 1,
    endSeq: 1,
    correlationState:
      map.source === 'launch' || map.source === 'admission'
        ? ('direct' as const)
        : ('inferred' as const),
  }))
  const stats = Object.values(input.hrcEventStats ?? {})
  const traceId = `trace_${shortHashId(
    hashValue({ taskId: task.taskId, firstEvent: events[0]?.eventId })
  )}`
  const workflowSeqRange: [number, number] = [
    events[0]?.workflowSeq ?? 0,
    events.at(-1)?.workflowSeq ?? 0,
  ]
  const trace: WorkflowTrace = {
    traceId,
    workflowTaskId: task.taskId,
    workflow: task.workflow,
    workflowSeqRange,
    hrcRanges,
    initialProjectionHash: hashValue(events[0] ?? task),
    finalProjectionHash: hashValue(task),
    outcome: {
      ...(task.state.phase !== undefined ? { phase: task.state.phase ?? undefined } : {}),
      closed: task.state.status === 'closed',
      ...(task.state.outcome === 'success'
        ? { result: 'success' as const }
        : task.state.status === 'closed'
          ? { result: 'inconclusive' as const }
          : {}),
      humanOverride: events.some((event) => event.type.includes('override')),
    },
    metrics: {
      transitionsAccepted: count(
        events,
        (event) => event.type.includes('transition') && event.result === 'accepted'
      ),
      transitionsRejected: count(
        events,
        (event) => event.type.includes('transition') && event.result === 'rejected'
      ),
      supervisorActionsAccepted: count(
        events,
        (event) => event.type.startsWith('supervisor') && event.result === 'accepted'
      ),
      supervisorActionsRejected: count(
        events,
        (event) => event.type.startsWith('supervisor') && event.result === 'rejected'
      ),
      evidenceAttached: count(events, (event) => event.type === 'evidence.attached'),
      evidenceRejected: count(events, (event) => event.type === 'evidence.rejected'),
      obligationsCreated: count(events, (event) => event.type === 'obligation.created'),
      obligationsWaived: count(events, (event) => event.type === 'obligation.waived'),
      anomaliesRecorded: input.snapshot.anomalies.filter(
        (anomaly) => anomaly.taskId === task.taskId
      ).length,
      participantRuns: input.snapshot.participantRuns.filter((run) => run.taskId === task.taskId)
        .length,
      hrcToolCalls: stats.reduce((sum, stat) => sum + (stat.toolCalls ?? 0), 0),
      hrcToolErrors: stats.reduce((sum, stat) => sum + (stat.toolErrors ?? 0), 0),
      wallMs:
        events.length > 1
          ? Math.max(
              0,
              Date.parse(events.at(-1)?.createdAt ?? '') - Date.parse(events[0]?.createdAt ?? '')
            )
          : 0,
    },
    correlation: {
      state: correlationState,
      missingKeys,
      warnings: missingKeys.map((key) => `missing ${key}`),
    },
  }
  const ingestReport: TraceIngestReport = {
    traceId,
    workflowTaskId: task.taskId,
    correlationState,
    missingKeys,
    conflictingKeys: [],
    hrcRanges: hrcRanges.map((range) => ({
      hrcRunId: range.hrcRunId,
      startSeq: range.startSeq,
      endSeq: range.endSeq,
    })),
    workflowSeqRange,
    warnings: trace.correlation.warnings,
  }
  return { trace, ingestReport }
}

export function runDeterministicWorkflowReplay(input: {
  snapshot: WorkflowKernelSnapshot
  workflowTaskId: string
  evaluatorVersion?: string | undefined
  patchBundleId?: string | undefined
  now?: string | undefined
}): ReplayReport {
  const { trace } = materializeWorkflowTrace(input)
  const events = input.snapshot.events
    .filter((event) => event.taskId === input.workflowTaskId)
    .sort((left, right) => left.workflowSeq - right.workflowSeq)
  const failedProperties: string[] = []
  events.forEach((event, index) => {
    if (event.workflowSeq !== index + 1) {
      failedProperties.push(`workflow_seq_gap:${event.eventId}`)
    }
    if (event.eventHash !== hashValue(eventHashInput(event))) {
      failedProperties.push(`event_hash_mismatch:${event.eventId}`)
    }
    const previous = events[index - 1]
    if (previous !== undefined && event.prevHash !== previous.eventHash) {
      failedProperties.push(`prev_hash_mismatch:${event.eventId}`)
    }
    if (event.result === 'rejected' && event.rejectionCode === undefined) {
      failedProperties.push(`missing_rejection_code:${event.eventId}`)
    }
  })
  return {
    reportId: `replay_${shortHashId(hashValue({ traceId: trace.traceId, failedProperties }))}`,
    ...(input.patchBundleId !== undefined ? { patchBundleId: input.patchBundleId } : {}),
    evaluatorVersion: input.evaluatorVersion ?? 'workflow-kernel-replay.v1',
    replayTraceIds: [trace.traceId],
    results: [
      {
        traceId: trace.traceId,
        outcome:
          failedProperties.length === 0
            ? 'passed'
            : events.length === 0
              ? 'inconclusive'
              : 'failed',
        failedProperties,
        ...(failedProperties.length > 0 ? { diffSummary: failedProperties.join(', ') } : {}),
      },
    ],
    createdAt: input.now ?? new Date().toISOString(),
  }
}

export function reviewTraceLabel(input: {
  label: TraceUseLabel
  reviewer: ActorRef
  proposer?: ActorRef | undefined
  reason: string
  now?: string | undefined
}): TraceUseLabel {
  const evalUse =
    input.label.use === 'usable_for_replay' || input.label.use === 'usable_for_regression'
  if (
    evalUse &&
    input.label.source === 'learner_proposed' &&
    input.proposer !== undefined &&
    input.proposer.kind === input.reviewer.kind &&
    input.proposer.id === input.reviewer.id
  ) {
    throw new Error('trusted eval-use labels require reviewer separation from learner proposer')
  }
  return {
    ...input.label,
    reviewedBy: input.reviewer,
    reason: input.reason,
    createdAt: input.now ?? input.label.createdAt,
  }
}

export function transitionLearningArtifactLifecycle<T extends LearningArtifactBase>(
  artifact: T,
  next: T['lifecycle'],
  input: { actor: ActorRef; reason: string; now?: string | undefined }
): T {
  const allowed: Record<LearningArtifactBase['lifecycle'], LearningArtifactBase['lifecycle'][]> = {
    draft: ['accepted', 'active', 'quarantined', 'archived'],
    accepted: ['active', 'quarantined', 'archived'],
    active: ['stale', 'archived', 'pinned', 'quarantined'],
    stale: ['active', 'archived', 'pinned'],
    archived: [],
    pinned: ['active', 'stale', 'archived'],
    quarantined: ['archived'],
  }
  if (!allowed[artifact.lifecycle].includes(next)) {
    throw new Error(
      `invalid learning artifact lifecycle transition: ${artifact.lifecycle}->${next}`
    )
  }
  return {
    ...artifact,
    lifecycle: next,
    updatedAt: input.now ?? new Date().toISOString(),
  }
}

export function validatePromotionReadiness(input: {
  patchBundle: PatchBundle
  replayReportIds: string[]
  evalReportIds: string[]
  promotionReviewer: ActorRef
  externalAuthority?: ActorRef | undefined
  now?: string | undefined
}): PromotionReadinessReport {
  const requiredAuthorities: string[] = []
  const risk = input.patchBundle.risk
  if (
    risk.changesAuthority ||
    risk.weakensRequirement ||
    risk.expandsCapability ||
    risk.changesEvaluator ||
    risk.changesTaskTaxonomy ||
    risk.suppressesOrReclassifiesAnomalies
  ) {
    requiredAuthorities.push('external_authority')
  }
  const unmetRequirements: string[] = []
  if (
    input.patchBundle.author.kind === input.promotionReviewer.kind &&
    input.patchBundle.author.id === input.promotionReviewer.id
  ) {
    unmetRequirements.push('promotion_reviewer_must_differ_from_patch_author')
  }
  if (input.replayReportIds.length === 0) {
    unmetRequirements.push('replay_report_required')
  }
  if (input.evalReportIds.length === 0) {
    unmetRequirements.push('eval_report_required')
  }
  if (requiredAuthorities.includes('external_authority') && input.externalAuthority === undefined) {
    unmetRequirements.push('external_authority_required')
  }
  return {
    reportId: `promotion_${shortHashId(
      hashValue({
        patchBundleId: input.patchBundle.patchBundleId,
        unmetRequirements,
      })
    )}`,
    patchBundleId: input.patchBundle.patchBundleId,
    replayReportIds: input.replayReportIds,
    evalReportIds: input.evalReportIds,
    riskSummary: stableJson(risk),
    requiredAuthorities,
    unmetRequirements,
    recommendation:
      unmetRequirements.length > 0
        ? 'reject'
        : requiredAuthorities.length > 0
          ? 'stage'
          : 'promote',
    rationale:
      unmetRequirements.length > 0
        ? 'Promotion requirements are not satisfied.'
        : 'Promotion requirements are satisfied.',
    createdAt: input.now ?? new Date().toISOString(),
  }
}
