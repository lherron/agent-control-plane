import type { FlowNext, JobFlow, JobFlowStep, StepExpectation } from 'acp-core'

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
  | 'invalid_step_kind'
  | 'missing_exec'
  | 'invalid_exec_argv'
  | 'invalid_exec_command'
  | 'invalid_exec_cwd'
  | 'invalid_exec_env'
  | 'invalid_exec_timeout'
  | 'invalid_exec_max_output_bytes'
  | 'invalid_branch_exit_code'
  | 'invalid_flow_next'
  | 'flow_cycle'
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
type FlowPhaseSteps = Partial<Record<FlowPhase, unknown[]>>

const allowedExpectationFields = new Set(['outcome', 'resultBlock', 'require', 'equals'])
const allowedOutcomes = new Set(['succeeded', 'failed', 'cancelled'])
const terminalFlowNext = new Set<FlowNext>(['continue', 'succeed', 'fail'])
const maxExecOutputBytes = 64 * 1024 * 1024

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

function validateExec(exec: unknown, path: string, errors: JobFlowValidationError[]): void {
  if (!isRecord(exec)) {
    addError(errors, 'missing_exec', path, 'exec step must include an exec object')
    return
  }

  if ('command' in exec) {
    addError(
      errors,
      'invalid_exec_command',
      `${path}.command`,
      'exec command strings are not supported'
    )
  }

  const argv = exec['argv']
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    addError(
      errors,
      'invalid_exec_argv',
      `${path}.argv`,
      'exec.argv must be a non-empty string array'
    )
  }

  if ('cwd' in exec && !hasPresentString(exec, 'cwd')) {
    addError(errors, 'invalid_exec_cwd', `${path}.cwd`, 'exec.cwd must be a non-empty string')
  }

  if ('env' in exec) {
    const env = exec['env']
    if (!isRecord(env) || Object.values(env).some((value) => typeof value !== 'string')) {
      addError(
        errors,
        'invalid_exec_env',
        `${path}.env`,
        'exec.env must be a string-to-string object'
      )
    }
  }

  if ('timeout' in exec) {
    const timeout = exec['timeout']
    if (typeof timeout !== 'string' || !isValidIsoDuration(timeout)) {
      addError(
        errors,
        'invalid_exec_timeout',
        `${path}.timeout`,
        'exec.timeout must be an ISO 8601 duration'
      )
    }
  }

  if ('maxOutputBytes' in exec) {
    const maxOutputBytes = exec['maxOutputBytes']
    if (
      typeof maxOutputBytes !== 'number' ||
      !Number.isInteger(maxOutputBytes) ||
      maxOutputBytes <= 0 ||
      maxOutputBytes > maxExecOutputBytes
    ) {
      addError(
        errors,
        'invalid_exec_max_output_bytes',
        `${path}.maxOutputBytes`,
        `exec.maxOutputBytes must be a positive integer no greater than ${maxExecOutputBytes}`
      )
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

  const kind = step['kind']
  if (kind !== undefined && kind !== 'agent' && kind !== 'exec') {
    addError(errors, 'invalid_step_kind', `${path}.kind`, 'step kind must be agent or exec')
  }

  const stepKind = kind === 'exec' ? 'exec' : 'agent'

  if ('next' in step && typeof step['next'] !== 'string') {
    addError(
      errors,
      'invalid_flow_next',
      `${path}.next`,
      'next must be a terminal token or step id'
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

  if (stepKind === 'exec') {
    if (!('exec' in step)) {
      addError(errors, 'missing_exec', `${path}.exec`, 'exec step must include an exec object')
    } else {
      validateExec(step['exec'], `${path}.exec`, errors)
    }
    validateBranchShape(step, path, errors)
    return
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

  if ('expect' in step) {
    validateExpectation(step['expect'], `${path}.expect`, errors)
  }
}

function validateBranchShape(
  step: Record<string, unknown>,
  path: string,
  errors: JobFlowValidationError[]
): void {
  if (!('branches' in step)) {
    return
  }

  const branches = step['branches']
  if (!isRecord(branches)) {
    addError(errors, 'invalid_flow_next', `${path}.branches`, 'branches must be an object')
    return
  }

  if ('exitCode' in branches) {
    const exitCode = branches['exitCode']
    if (!isRecord(exitCode)) {
      addError(
        errors,
        'invalid_branch_exit_code',
        `${path}.branches.exitCode`,
        'branches.exitCode must be an object'
      )
    } else {
      for (const [exitCodeKey, target] of Object.entries(exitCode)) {
        if (!isValidExitCodeKey(exitCodeKey)) {
          addError(
            errors,
            'invalid_branch_exit_code',
            `${path}.branches.exitCode.${exitCodeKey}`,
            'branch exit codes must be integer strings from 0 to 255'
          )
        }
        if (typeof target !== 'string') {
          addError(
            errors,
            'invalid_flow_next',
            `${path}.branches.exitCode.${exitCodeKey}`,
            'branch target must be a terminal token or step id'
          )
        }
      }
    }
  }

  if ('default' in branches && typeof branches['default'] !== 'string') {
    addError(
      errors,
      'invalid_flow_next',
      `${path}.branches.default`,
      'branch default must be a terminal token or step id'
    )
  }
}

function isValidExitCodeKey(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false
  }
  const exitCode = Number(value)
  return exitCode >= 0 && exitCode <= 255
}

function collectPhaseStepIds(steps: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const step of steps) {
    if (isRecord(step) && hasPresentString(step, 'id')) {
      ids.add(step['id'] as string)
    }
  }
  return ids
}

function validateFlowNextTarget(
  target: unknown,
  path: string,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): target is string {
  if (typeof target !== 'string') {
    return false
  }

  if (!terminalFlowNext.has(target as FlowNext) && !phaseStepIds.has(target)) {
    addError(
      errors,
      'invalid_flow_next',
      path,
      'flow target must be continue, succeed, fail, or a step id in the same phase'
    )
  }

  return true
}

function validateBranchTargets(
  steps: unknown[],
  phase: FlowPhase,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): void {
  steps.forEach((step, index) => {
    if (!isRecord(step)) {
      return
    }

    const path = `flow.${phase}[${index}]`
    if ('next' in step) {
      validateFlowNextTarget(step['next'], `${path}.next`, phaseStepIds, errors)
    }

    if (step['kind'] !== 'exec' || !isRecord(step['branches'])) {
      return
    }

    const branches = step['branches']
    if (isRecord(branches['exitCode'])) {
      for (const [exitCode, target] of Object.entries(branches['exitCode'])) {
        validateFlowNextTarget(
          target,
          `${path}.branches.exitCode.${exitCode}`,
          phaseStepIds,
          errors
        )
      }
    }

    if ('default' in branches) {
      validateFlowNextTarget(branches['default'], `${path}.branches.default`, phaseStepIds, errors)
    }
  })
}

function addEdgeForFlowNext(
  edges: Map<string, Set<string>>,
  from: string,
  target: unknown,
  phaseStepIds: Set<string>
): void {
  if (
    typeof target !== 'string' ||
    terminalFlowNext.has(target as FlowNext) ||
    !phaseStepIds.has(target)
  ) {
    return
  }

  edges.get(from)?.add(target)
}

function validatePhaseAcyclic(
  steps: unknown[],
  phase: FlowPhase,
  phaseStepIds: Set<string>,
  errors: JobFlowValidationError[]
): void {
  const orderedIds = steps
    .filter(
      (step): step is Record<string, unknown> => isRecord(step) && hasPresentString(step, 'id')
    )
    .map((step) => step['id'] as string)
  const edges = new Map(orderedIds.map((id) => [id, new Set<string>()]))

  for (const [index, id] of orderedIds.entries()) {
    const nextId = orderedIds[index + 1]
    if (nextId !== undefined) {
      edges.get(id)?.add(nextId)
    }
  }

  for (const step of steps) {
    if (!isRecord(step) || !hasPresentString(step, 'id')) {
      continue
    }

    const id = step['id'] as string
    addEdgeForFlowNext(edges, id, step['next'], phaseStepIds)

    if (step['kind'] !== 'exec' || !isRecord(step['branches'])) {
      continue
    }

    const branches = step['branches']
    if (isRecord(branches['exitCode'])) {
      for (const target of Object.values(branches['exitCode'])) {
        addEdgeForFlowNext(edges, id, target, phaseStepIds)
      }
    }
    addEdgeForFlowNext(edges, id, branches['default'], phaseStepIds)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(id: string): boolean {
    if (visiting.has(id)) {
      return true
    }
    if (visited.has(id)) {
      return false
    }

    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (visit(next)) {
        return true
      }
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const id of orderedIds) {
    if (visit(id)) {
      addError(errors, 'flow_cycle', `flow.${phase}`, `flow.${phase} contains a cycle`)
      return
    }
  }
}

function validatePhaseFlowGraph(phases: FlowPhaseSteps, errors: JobFlowValidationError[]): void {
  for (const phase of ['sequence', 'onFailure'] as const) {
    const steps = phases[phase]
    if (steps === undefined) {
      continue
    }

    const phaseStepIds = collectPhaseStepIds(steps)
    validateBranchTargets(steps, phase, phaseStepIds, errors)
  }

  if (errors.length > 0) {
    return
  }

  for (const phase of ['sequence', 'onFailure'] as const) {
    const steps = phases[phase]
    if (steps === undefined) {
      continue
    }

    validatePhaseAcyclic(steps, phase, collectPhaseStepIds(steps), errors)
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
