import type { JobFlow, JobFlowStep, StepExpectation } from 'acp-core'

import { isValidCron } from './cron.js'
import type { JobSchedule } from './open-store.js'

export type JobFlowValidationErrorCode =
  | 'invalid_cron'
  | 'missing_sequence'
  | 'empty_sequence'
  | 'invalid_step'
  | 'duplicate_step_id'
  | 'missing_step_input'
  | 'ambiguous_step_input'
  | 'input_file_not_allowed'
  | 'unsupported_expect_field'
  | 'invalid_expect_require'
  | 'invalid_expect_equals_key'
  | 'invalid_expect_equals_value'
  | 'unsupported_expect_outcome'
  | 'invalid_fresh'
  | 'invalid_timeout'

export type JobFlowValidationError = {
  code: JobFlowValidationErrorCode
  path: string
  message: string
}

export type JobFlowValidationResult =
  | { valid: true }
  | { valid: false; errors: JobFlowValidationError[] }

export type ValidateJobFlowOptions = {
  allowInputFile?: boolean | undefined
}

export type ValidateJobFlowJobInput = {
  schedule?: JobSchedule | undefined
  flow?: unknown
}

type FlowPhase = 'sequence' | 'onFailure'

const allowedExpectationFields = new Set(['outcome', 'resultBlock', 'require', 'equals'])
const allowedOutcomes = new Set(['succeeded', 'failed', 'cancelled'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function hasPresentString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return typeof value === 'string' && value.length > 0
}

function isTopLevelFieldName(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !/[.[\]]/.test(trimmed)
}

function isValidIsoDuration(value: string): boolean {
  return /^P(?=.)(?:(?:\d+(?:[.,]\d+)?Y)?(?:\d+(?:[.,]\d+)?M)?(?:\d+(?:[.,]\d+)?W)?(?:\d+(?:[.,]\d+)?D)?(?:T(?=.)(?:\d+(?:[.,]\d+)?H)?(?:\d+(?:[.,]\d+)?M)?(?:\d+(?:[.,]\d+)?S)?)?)$/.test(
    value
  )
}

function addError(
  errors: JobFlowValidationError[],
  code: JobFlowValidationErrorCode,
  path: string,
  message: string
): void {
  errors.push({ code, path, message })
}

function validateExpectation(
  expect: unknown,
  path: string,
  errors: JobFlowValidationError[]
): void {
  if (!isRecord(expect)) {
    addError(errors, 'unsupported_expect_field', path, 'expect must be an object')
    return
  }

  for (const key of Object.keys(expect)) {
    if (!allowedExpectationFields.has(key)) {
      addError(
        errors,
        'unsupported_expect_field',
        `${path}.${key}`,
        `unsupported expect field: ${key}`
      )
    }
  }

  if ('outcome' in expect) {
    const outcome = expect['outcome']
    if (typeof outcome !== 'string' || !allowedOutcomes.has(outcome)) {
      addError(
        errors,
        'unsupported_expect_outcome',
        `${path}.outcome`,
        `unsupported expect.outcome: ${String(outcome)}`
      )
    }
  }

  if ('require' in expect) {
    const require = expect['require']
    if (!Array.isArray(require)) {
      addError(
        errors,
        'invalid_expect_require',
        `${path}.require`,
        'expect.require must be an array'
      )
    } else {
      require.forEach((entry, index) => {
        if (typeof entry !== 'string' || !isTopLevelFieldName(entry)) {
          addError(
            errors,
            'invalid_expect_require',
            `${path}.require[${index}]`,
            'expect.require entries must be non-empty top-level field names'
          )
        }
      })
    }
  }

  if ('equals' in expect) {
    const equals = expect['equals']
    if (!isRecord(equals)) {
      addError(
        errors,
        'invalid_expect_equals_value',
        `${path}.equals`,
        'expect.equals must be an object'
      )
    } else {
      for (const [key, value] of Object.entries(equals)) {
        if (!isTopLevelFieldName(key)) {
          addError(
            errors,
            'invalid_expect_equals_key',
            `${path}.equals.${key}`,
            'expect.equals keys must be top-level field names'
          )
        }
        if (!isScalar(value)) {
          addError(
            errors,
            'invalid_expect_equals_value',
            `${path}.equals.${key}`,
            'expect.equals values must be scalar'
          )
        }
      }
    }
  }
}

function validateStep(
  step: unknown,
  phase: FlowPhase,
  index: number,
  options: ValidateJobFlowOptions,
  seenIds: Map<string, string>,
  errors: JobFlowValidationError[]
): void {
  const path = `flow.${phase}[${index}]`
  if (!isRecord(step)) {
    addError(errors, 'invalid_step', path, 'step must be an object')
    return
  }

  if (!hasPresentString(step, 'id')) {
    addError(errors, 'invalid_step', `${path}.id`, 'step id must be a non-empty string')
  } else {
    const id = step['id'] as string
    const existingPath = seenIds.get(id)
    if (existingPath !== undefined) {
      addError(errors, 'duplicate_step_id', `${path}.id`, `duplicate step id: ${id}`)
    } else {
      seenIds.set(id, `${path}.id`)
    }
  }

  const hasInput = hasPresentString(step, 'input')
  const hasInputFile = hasPresentString(step, 'inputFile')
  if (!hasInput && !hasInputFile) {
    addError(
      errors,
      'missing_step_input',
      path,
      'step must include exactly one of input or inputFile'
    )
  }
  if (hasInput && hasInputFile) {
    addError(errors, 'ambiguous_step_input', path, 'step must not include both input and inputFile')
  }
  if (hasInputFile && options.allowInputFile !== true) {
    addError(
      errors,
      'input_file_not_allowed',
      `${path}.inputFile`,
      'server-side validation rejects unresolved inputFile'
    )
  }

  if ('fresh' in step && typeof step['fresh'] !== 'boolean') {
    addError(errors, 'invalid_fresh', `${path}.fresh`, 'fresh must be a boolean')
  }

  if ('timeout' in step) {
    const timeout = step['timeout']
    if (typeof timeout !== 'string' || !isValidIsoDuration(timeout)) {
      addError(errors, 'invalid_timeout', `${path}.timeout`, 'timeout must be an ISO 8601 duration')
    }
  }

  if ('expect' in step) {
    validateExpectation(step['expect'], `${path}.expect`, errors)
  }
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

  const seenIds = new Map<string, string>()
  if (Array.isArray(sequence)) {
    sequence.forEach((step, index) =>
      validateStep(step, 'sequence', index, options, seenIds, errors)
    )
  }

  const onFailure = flow['onFailure']
  if (onFailure !== undefined) {
    if (!Array.isArray(onFailure)) {
      addError(errors, 'invalid_step', 'flow.onFailure', 'flow.onFailure must be an array')
    } else {
      onFailure.forEach((step, index) =>
        validateStep(step, 'onFailure', index, options, seenIds, errors)
      )
    }
  }

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

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

export function assertValidJobFlow(
  flow: unknown,
  options?: ValidateJobFlowOptions
): asserts flow is JobFlow {
  const result = validateJobFlow(flow, options)
  if (!result.valid) {
    throw new Error(`invalid job flow: ${result.errors.map((error) => error.code).join(', ')}`)
  }
}

export type { JobFlow, JobFlowStep, StepExpectation }
