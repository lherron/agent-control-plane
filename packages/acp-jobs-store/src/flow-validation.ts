import type { JobFlow, JobFlowStep, StepExpectation } from 'acp-core'

import { isValidCron } from './cron.js'
import { validatePhaseFlowGraph } from './flow-graph-validation.js'
import { validateStep } from './flow-step-validation.js'
import {
  type JobFlowValidationError,
  type JobFlowValidationResult,
  type ValidateJobFlowJobInput,
  type ValidateJobFlowOptions,
  addError,
  hasPresentString,
  isRecord,
} from './flow-validation-context.js'

// Preserve the public validation contract at its established import path.
export type {
  JobFlowValidationErrorCode,
  JobFlowValidationError,
  JobFlowValidationResult,
  ValidateJobFlowOptions,
  ValidateJobFlowJobInput,
} from './flow-validation-context.js'

export function formatJobFlowValidationErrors(errors: readonly JobFlowValidationError[]): string {
  return errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ')
}

function collectFreshDurationPaths(flow: unknown): string[] {
  if (!isRecord(flow)) {
    return []
  }

  const paths: string[] = []
  for (const phase of ['sequence', 'onFailure'] as const) {
    const steps = flow[phase]
    if (!Array.isArray(steps)) {
      continue
    }
    steps.forEach((step, index) => {
      if (isRecord(step) && 'freshDuration' in step) {
        paths.push(`flow.${phase}[${index}].freshDuration`)
      }
    })
  }
  return paths
}

export function validateJobFlow(
  flow: unknown,
  options: ValidateJobFlowOptions = {}
): JobFlowValidationResult {
  const errors: JobFlowValidationError[] = []
  if (!isRecord(flow)) {
    addError(errors, 'missing_sequence', 'flow.sequence', 'flow.sequence is required')
    return { valid: false, errors }
  }

  const sequence = flow['sequence']
  if (!Array.isArray(sequence)) {
    addError(errors, 'missing_sequence', 'flow.sequence', 'flow.sequence is required')
  } else if (sequence.length === 0) {
    addError(
      errors,
      'empty_sequence',
      'flow.sequence',
      'flow.sequence must include at least one step'
    )
  }

  const seenIds = new Set<string>()
  const onFailure = flow['onFailure']
  for (const [phase, steps] of [
    ['sequence', sequence],
    ['onFailure', onFailure],
  ] as const) {
    if (phase === 'onFailure' && steps !== undefined && !Array.isArray(steps)) {
      addError(errors, 'invalid_step', 'flow.onFailure', 'flow.onFailure must be an array')
    }
    if (Array.isArray(steps)) {
      const priorStepIds = new Set<string>()
      steps.forEach((step, index) => {
        validateStep(step, phase, index, options, seenIds, priorStepIds, errors)
        if (isRecord(step) && hasPresentString(step, 'id')) {
          priorStepIds.add(step['id'] as string)
        }
      })
    }
  }

  validatePhaseFlowGraph(
    {
      ...(Array.isArray(sequence) ? { sequence } : {}),
      ...(Array.isArray(onFailure) ? { onFailure } : {}),
    },
    errors
  )

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

export function validateJobFlowJob(
  input: ValidateJobFlowJobInput,
  options: ValidateJobFlowOptions = {}
): JobFlowValidationResult {
  const errors: JobFlowValidationError[] = []
  if (input.schedule !== undefined && !isValidCron(input.schedule.cron)) {
    addError(
      errors,
      'invalid_cron',
      'schedule.cron',
      `invalid cron schedule: ${input.schedule.cron}`
    )
  }

  const flowResult = validateJobFlow(input.flow, options)
  if (!flowResult.valid) {
    errors.push(...flowResult.errors)
  }

  const triggerKind = input.triggerKind ?? (input.schedule !== undefined ? 'schedule' : undefined)
  if (triggerKind !== undefined && triggerKind !== 'schedule') {
    for (const path of collectFreshDurationPaths(input.flow)) {
      addError(
        errors,
        'invalid_fresh_duration',
        path,
        'freshDuration is only supported for scheduled flow jobs'
      )
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

export type { JobFlow, JobFlowStep, StepExpectation }
