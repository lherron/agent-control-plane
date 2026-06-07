import { type JobRecord, type JobRunRecord, nextFireAfter } from 'acp-jobs-store'

import type { JobFlow, JobFlowStep } from 'acp-core'

export type ProvenanceEntry = {
  source: string
  available: boolean
  note?: string | undefined
}

export type JobKind = 'input' | 'flow' | 'exec'

export type JobSummary = {
  kind: JobKind
  title: string
  description?: string | undefined
  disabledReason?: string | undefined
  flowStepCount: number
  onFailureStepCount: number
}

export type CompactJobSummary = {
  kind: JobKind
  disabled: boolean
  nextFireAt?: string | undefined
  lastFireAt?: string | undefined
  flowStepCount: number
  onFailureStepCount: number
}

export type NormalizedFlowStep = JobFlowStep & {
  phase: 'sequence' | 'onFailure'
  index: number
}

export type NormalizedFlowEdge = {
  from: string
  to: string
  label: 'continue' | 'succeed' | 'fail' | 'onFailure'
}

export type NormalizedFlow = {
  nodes: NormalizedFlowStep[]
  sequence: NormalizedFlowStep[]
  onFailure: NormalizedFlowStep[]
  edges: NormalizedFlowEdge[]
  warnings: string[]
}

function isExecStep(step: JobFlowStep): boolean {
  return step.kind === 'exec'
}

function readInputContent(input: Readonly<Record<string, unknown>>): string | undefined {
  const content = input['content']
  return typeof content === 'string' && content.trim().length > 0 ? content.trim() : undefined
}

export function summarizeJob(job: JobRecord): JobSummary {
  const flowStepCount = job.flow?.sequence.length ?? 0
  const onFailureStepCount = job.flow?.onFailure?.length ?? 0
  const kind: JobKind =
    job.flow !== undefined
      ? 'flow'
      : Array.isArray(job.input['argv']) || typeof job.input['command'] === 'string'
        ? 'exec'
        : 'input'
  const content = readInputContent(job.input)
  const fallbackDescription =
    content === undefined
      ? undefined
      : content.length > 160
        ? `${content.slice(0, 157)}...`
        : content
  const description = job.description ?? fallbackDescription

  return {
    kind,
    title: job.slug,
    ...(description !== undefined ? { description } : {}),
    ...(job.disabled ? { disabledReason: 'job is disabled' } : {}),
    flowStepCount,
    onFailureStepCount,
  }
}

export function summarizeCompactJob(job: JobRecord): CompactJobSummary {
  const summary = summarizeJob(job)
  return {
    kind: summary.kind,
    disabled: job.disabled,
    ...(job.nextFireAt !== undefined ? { nextFireAt: job.nextFireAt } : {}),
    ...(job.lastFireAt !== undefined ? { lastFireAt: job.lastFireAt } : {}),
    flowStepCount: summary.flowStepCount,
    onFailureStepCount: summary.onFailureStepCount,
  }
}

export function buildScheduleSummary(job: JobRecord):
  | {
      cron: string
      lastFireAt?: string | undefined
      nextFireAt?: string | undefined
      nextFirePreview?: string[] | undefined
      windowStart?: string | undefined
      windowEnd?: string | undefined
      windowMinutes?: number | undefined
    }
  | undefined {
  // Event-triggered jobs carry no schedule; the detail surface omits this block.
  const schedule = job.schedule
  if (schedule === undefined) {
    return undefined
  }
  const preview: string[] = []
  let cursor = job.nextFireAt ?? nextFireAfter(schedule.cron, new Date().toISOString())
  for (let index = 0; index < 5 && cursor !== null; index += 1) {
    preview.push(cursor)
    cursor = nextFireAfter(schedule.cron, cursor)
  }

  return {
    cron: schedule.cron,
    ...(job.lastFireAt !== undefined ? { lastFireAt: job.lastFireAt } : {}),
    ...(job.nextFireAt !== undefined ? { nextFireAt: job.nextFireAt } : {}),
    ...(preview.length > 0 ? { nextFirePreview: preview } : {}),
    ...(schedule.windowStart !== undefined ? { windowStart: schedule.windowStart } : {}),
    ...(schedule.windowEnd !== undefined ? { windowEnd: schedule.windowEnd } : {}),
    ...(typeof schedule.windowMinutes === 'number' ? { windowMinutes: schedule.windowMinutes } : {}),
  }
}

export function latestJobRuns(jobRuns: readonly JobRunRecord[], limit = 10): JobRunRecord[] {
  return [...jobRuns]
    .sort((left, right) => {
      const byTriggeredAt = right.triggeredAt.localeCompare(left.triggeredAt)
      return byTriggeredAt === 0 ? right.jobRunId.localeCompare(left.jobRunId) : byTriggeredAt
    })
    .slice(0, limit)
}

function normalizeSteps(
  steps: readonly JobFlowStep[] | undefined,
  phase: 'sequence' | 'onFailure'
): NormalizedFlowStep[] {
  return (steps ?? []).map((step, index) => ({ ...step, phase, index }))
}

function edgeLabelForTarget(target: string): NormalizedFlowEdge['label'] {
  if (target === 'succeed' || target === 'fail') {
    return target
  }
  return 'continue'
}

function addEdge(
  edges: NormalizedFlowEdge[],
  edgeKeys: Set<string>,
  from: string,
  to: string,
  label: NormalizedFlowEdge['label']
): void {
  const key = `${from}\u0000${to}\u0000${label}`
  if (edgeKeys.has(key)) {
    return
  }
  edgeKeys.add(key)
  edges.push({ from, to, label })
}

function addTransitionEdge(input: {
  edges: NormalizedFlowEdge[]
  edgeKeys: Set<string>
  warnings: string[]
  step: JobFlowStep
  target: unknown
  phase: 'sequence' | 'onFailure'
  stepIds: ReadonlySet<string>
  path: string
}): void {
  if (typeof input.target !== 'string') {
    return
  }

  if (input.target === 'continue') {
    return
  }

  if (input.target === 'succeed' || input.target === 'fail') {
    addEdge(input.edges, input.edgeKeys, input.step.id, input.target, input.target)
    return
  }

  if (!input.stepIds.has(input.target)) {
    input.warnings.push(`${input.path} points to missing ${input.phase} step: ${input.target}`)
    return
  }

  addEdge(
    input.edges,
    input.edgeKeys,
    input.step.id,
    input.target,
    edgeLabelForTarget(input.target)
  )
}

function addPhaseEdges(input: {
  steps: readonly JobFlowStep[]
  phase: 'sequence' | 'onFailure'
  edges: NormalizedFlowEdge[]
  edgeKeys: Set<string>
  warnings: string[]
}): void {
  const stepIds = new Set(input.steps.map((step) => step.id))

  input.steps.forEach((step, index) => {
    const nextStep = input.steps[index + 1]
    if (nextStep !== undefined) {
      addEdge(input.edges, input.edgeKeys, step.id, nextStep.id, 'continue')
    }

    addTransitionEdge({
      edges: input.edges,
      edgeKeys: input.edgeKeys,
      warnings: input.warnings,
      step,
      target: step.next,
      phase: input.phase,
      stepIds,
      path: `${input.phase}.${step.id}.next`,
    })

    if (!isExecStep(step) || step.kind !== 'exec') {
      return
    }

    if (step.branches?.exitCode !== undefined) {
      for (const [exitCode, target] of Object.entries(step.branches.exitCode)) {
        addTransitionEdge({
          edges: input.edges,
          edgeKeys: input.edgeKeys,
          warnings: input.warnings,
          step,
          target,
          phase: input.phase,
          stepIds,
          path: `${input.phase}.${step.id}.branches.exitCode.${exitCode}`,
        })
      }
    }

    addTransitionEdge({
      edges: input.edges,
      edgeKeys: input.edgeKeys,
      warnings: input.warnings,
      step,
      target: step.branches?.default,
      phase: input.phase,
      stepIds,
      path: `${input.phase}.${step.id}.branches.default`,
    })
  })
}

function warnUnreachable(input: {
  steps: readonly JobFlowStep[]
  phase: 'sequence' | 'onFailure'
  edges: readonly NormalizedFlowEdge[]
  warnings: string[]
}): void {
  const first = input.steps[0]
  if (first === undefined) {
    return
  }

  const stepIds = new Set(input.steps.map((step) => step.id))
  const outgoing = new Map<string, string[]>()
  for (const edge of input.edges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
      continue
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }

  const reachable = new Set<string>()
  const stack = [first.id]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (reachable.has(current)) {
      continue
    }
    reachable.add(current)
    for (const target of outgoing.get(current) ?? []) {
      stack.push(target)
    }
  }

  for (const step of input.steps) {
    if (!reachable.has(step.id)) {
      input.warnings.push(`${input.phase}.${step.id} is unreachable from the first step`)
    }
  }
}

export function normalizeFlow(flow: JobFlow): NormalizedFlow {
  const sequence = normalizeSteps(flow.sequence, 'sequence')
  const onFailure = normalizeSteps(flow.onFailure, 'onFailure')
  const edges: NormalizedFlowEdge[] = []
  const edgeKeys = new Set<string>()
  const warnings: string[] = []

  addPhaseEdges({ steps: flow.sequence, phase: 'sequence', edges, edgeKeys, warnings })
  addPhaseEdges({ steps: flow.onFailure ?? [], phase: 'onFailure', edges, edgeKeys, warnings })

  const firstOnFailureStep = flow.onFailure?.[0]
  if (firstOnFailureStep !== undefined) {
    for (const step of flow.sequence) {
      addEdge(edges, edgeKeys, step.id, firstOnFailureStep.id, 'onFailure')
    }
  }

  warnUnreachable({ steps: flow.sequence, phase: 'sequence', edges, warnings })
  warnUnreachable({ steps: flow.onFailure ?? [], phase: 'onFailure', edges, warnings })

  return {
    nodes: [...sequence, ...onFailure],
    sequence,
    onFailure,
    edges,
    warnings,
  }
}

export function provenance(source: string, available: boolean, note?: string): ProvenanceEntry {
  return {
    source,
    available,
    ...(note !== undefined ? { note } : {}),
  }
}
