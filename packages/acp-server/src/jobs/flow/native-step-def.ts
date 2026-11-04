import type { JobFlowStep, JobStepRunPhase } from 'acp-core'
import type { JobRecord, JobRunRecord, JobsStore } from 'acp-jobs-store'

import { isRecord } from '../../wrkf/value.js'
import { isExecStep } from './step-kinds.js'
import { currentStepRun } from './step-runs.js'

// Resolves a native step's declared definition against the run: `{$step, field}`
// output refs, `{{input.x}}` / `{{step.field}}` content templates, and the
// failed-branch diagnostics an onFailure-style target may read.

type StepOutputRef = { $step: string; field: string }

type FailedBranchDiagnosticResolution = { authorized: false } | { authorized: true; value: string }

const NATIVE_TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g

export function resolveNativeStepDef(input: {
  jobsStore: JobsStore
  job: JobRecord
  jobRun: JobRunRecord
  phase: JobStepRunPhase
  step: JobFlowStep
}): {
  stepDef: Readonly<Record<string, unknown>>
  resolvedFields: Readonly<Record<string, string>>
} {
  const resolvedFields: Record<string, string> = {}
  const canonicalEventId = readCanonicalEventId(input.jobRun)
  if (canonicalEventId !== undefined) {
    resolvedFields['_canonicalEventId'] = canonicalEventId
  }

  const resolveValue = (value: unknown): unknown => {
    if (isStepOutputRef(value)) {
      const resolved = resolveCurrentStepOutputRef(
        input.jobsStore,
        input.jobRun.jobRunId,
        input.phase,
        value
      )
      if (resolved === undefined) {
        throw new Error(`unresolved step output ref ${value.$step}.${value.field}`)
      }
      resolvedFields[`${value.$step}.${value.field}`] = resolved
      return resolved
    }
    if (typeof value === 'string') {
      return resolveNativeContentTemplate(input, value)
    }
    if (Array.isArray(value)) {
      return value.map(resolveValue)
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
          key,
          resolveValue(nested),
        ])
      )
    }
    return value
  }

  const resolved = resolveValue(input.step) as Record<string, unknown>
  if (input.step.kind === 'agent-dispatch') {
    const dispatchInput = resolved['input']
    if (isRecord(dispatchInput) && typeof dispatchInput['content'] === 'string') {
      resolved['content'] = dispatchInput['content']
    }
  }
  if (
    input.step.kind === 'wrkq-task' &&
    resolved['description'] === undefined &&
    typeof input.jobRun.resolvedInput?.['content'] === 'string'
  ) {
    resolved['description'] = input.jobRun.resolvedInput['content']
  }

  return { stepDef: resolved, resolvedFields }
}

function isStepOutputRef(value: unknown): value is StepOutputRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['$step'] === 'string' &&
    typeof (value as Record<string, unknown>)['field'] === 'string'
  )
}

function resolveCurrentStepOutputRef(
  jobsStore: JobsStore,
  jobRunId: string,
  phase: JobStepRunPhase,
  ref: StepOutputRef
): string | undefined {
  const stepRun = currentStepRun(jobsStore, jobRunId, phase, ref.$step)
  if (stepRun === undefined || stepRun.status !== 'succeeded') {
    return undefined
  }

  const value = stepRun.result?.[ref.field]
  return typeof value === 'string' ? value : undefined
}

function resolveNativeContentTemplate(
  input: {
    jobsStore: JobsStore
    job: JobRecord
    jobRun: JobRunRecord
    phase: JobStepRunPhase
    step: JobFlowStep
  },
  value: string
): string {
  const { jobsStore, job, jobRun, phase } = input
  return value.replace(NATIVE_TEMPLATE_PATTERN, (match, name: string) => {
    if (name.startsWith('input.')) {
      const field = name.slice('input.'.length)
      const resolved = jobRun.resolvedInput?.[field]
      return typeof resolved === 'string' ? resolved : match
    }
    const [stepId, field, ...rest] = name.split('.')
    if (stepId === undefined || field === undefined || rest.length > 0) {
      return match
    }
    const resolved = resolveCurrentStepOutputRef(jobsStore, jobRun.jobRunId, phase, {
      $step: stepId,
      field,
    })
    if (resolved !== undefined) {
      return resolved
    }

    const diagnostic = resolveFailedBranchDiagnosticOutputRef({
      jobsStore,
      job,
      jobRunId: jobRun.jobRunId,
      phase,
      targetStepId: input.step.id,
      sourceStepId: stepId,
      field,
    })
    return diagnostic.authorized ? diagnostic.value : match
  })
}

// A failed exec step's output and error are readable only by the step its
// exitCode/default branch routed to.
function resolveFailedBranchDiagnosticOutputRef(input: {
  jobsStore: JobsStore
  job: JobRecord
  jobRunId: string
  phase: JobStepRunPhase
  targetStepId: string
  sourceStepId: string
  field: string
}): FailedBranchDiagnosticResolution {
  const phaseSteps =
    input.phase === 'sequence' ? input.job.flow?.sequence : input.job.flow?.onFailure
  const sourceStep = phaseSteps?.find((step) => step.id === input.sourceStepId)
  if (sourceStep === undefined || !isExecStep(sourceStep)) {
    return { authorized: false }
  }

  const sourceRun = currentStepRun(input.jobsStore, input.jobRunId, input.phase, input.sourceStepId)
  const branch = sourceRun?.branchTaken
  if (
    sourceRun?.status !== 'failed' ||
    branch?.target !== input.targetStepId ||
    (branch.kind !== 'exitCode' && branch.kind !== 'default')
  ) {
    return { authorized: false }
  }

  if (input.field === 'errorCode') {
    return { authorized: true, value: sourceRun.error?.code ?? '' }
  }
  if (input.field === 'errorMessage') {
    return { authorized: true, value: sourceRun.error?.message ?? '' }
  }

  const value = sourceRun.result?.[input.field]
  return { authorized: true, value: typeof value === 'string' ? value : '' }
}

function readCanonicalEventId(jobRun: JobRunRecord): string | undefined {
  const source = jobRun.source
  if (source === undefined) {
    return undefined
  }
  const canonical = source['canonicalEventId']
  if (typeof canonical === 'string') {
    return canonical
  }
  const sourceName = source['source']
  const eventId = source['eventId']
  if (typeof sourceName === 'string' && typeof eventId === 'string') {
    return `${sourceName}:${eventId}`
  }
  return undefined
}
