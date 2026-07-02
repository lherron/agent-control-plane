import type { FlowNext, JobFlow, JobFlowStep, JobTriggerKind, StepExpectation } from 'acp-core'

import { isValidCron } from './cron.js'
import { isValidFreshDuration } from './fresh-duration.js'
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
  | 'invalid_probe_step'
  | 'unknown_probe_name'
  | 'missing_exec'
  | 'invalid_exec_argv'
  | 'invalid_exec_command'
  | 'invalid_exec_cwd'
  | 'invalid_exec_env'
  | 'invalid_exec_timeout'
  | 'invalid_exec_max_output_bytes'
  | 'invalid_exec_success_exit_codes'
  | 'invalid_branch_exit_code'
  | 'invalid_flow_next'
  | 'flow_cycle'
  | 'unsupported_expect_field'
  | 'invalid_expect_require'
  | 'invalid_expect_equals_key'
  | 'invalid_expect_equals_value'
  | 'unsupported_expect_outcome'
  | 'invalid_fresh'
  | 'invalid_fresh_duration'
  | 'invalid_timeout'
  // Phase A: native side-effect step validation
  | 'invalid_wrkq_task_step'
  | 'invalid_pulpit_message_step'
  | 'invalid_agent_dispatch_step'
  // Phase A: step-output ref validation
  | 'invalid_step_output_ref'
  | 'step_output_ref_unknown_step'
  // Phase A: authority field guard
  | 'authority_field_interpolation'

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
  triggerKind?: JobTriggerKind | undefined
  flow?: unknown
}

export function formatJobFlowValidationErrors(errors: readonly JobFlowValidationError[]): string {
  return errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ')
}

type FlowPhase = 'sequence' | 'onFailure'
type FlowPhaseSteps = Partial<Record<FlowPhase, unknown[]>>

const allowedExpectationFields = new Set(['outcome', 'resultBlock', 'require', 'equals'])
const allowedOutcomes = new Set(['succeeded', 'failed', 'cancelled'])
const terminalFlowNext = new Set<FlowNext>(['continue', 'succeed', 'fail'])
const allowedStepKinds = new Set([
  'agent',
  'exec',
  'probe',
  'wrkq-task',
  'pulpit-message',
  'agent-dispatch',
])
const knownProbeNames = new Set(['hrc-stale-tty-reap.v1'])
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

function containsTemplateInterpolation(value: string): boolean {
  return /{{\s*[^}]+\s*}}/.test(value)
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
  } else {
    argv.forEach((entry, index) => {
      if (containsTemplateInterpolation(entry)) {
        addError(
          errors,
          'authority_field_interpolation',
          `${path}.argv[${index}]`,
          'exec.argv entries must not contain template interpolation'
        )
      }
    })
  }

  if ('cwd' in exec && !hasPresentString(exec, 'cwd')) {
    addError(errors, 'invalid_exec_cwd', `${path}.cwd`, 'exec.cwd must be a non-empty string')
  } else if (typeof exec['cwd'] === 'string' && containsTemplateInterpolation(exec['cwd'])) {
    addError(
      errors,
      'authority_field_interpolation',
      `${path}.cwd`,
      'exec.cwd must not contain template interpolation'
    )
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
    } else {
      for (const [key, value] of Object.entries(env)) {
        const stringValue = value as string
        if (containsTemplateInterpolation(stringValue)) {
          addError(
            errors,
            'authority_field_interpolation',
            `${path}.env.${key}`,
            'exec.env values must not contain template interpolation'
          )
        }
      }
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

  if ('successExitCodes' in exec) {
    const successExitCodes = exec['successExitCodes']
    if (
      !Array.isArray(successExitCodes) ||
      successExitCodes.length === 0 ||
      successExitCodes.some((entry) => !isValidExitCodeNumber(entry))
    ) {
      addError(
        errors,
        'invalid_exec_success_exit_codes',
        `${path}.successExitCodes`,
        'exec.successExitCodes must be a non-empty integer array with values from 0 to 255'
      )
    }
  }
}

function validateProbe(probe: unknown, path: string, errors: JobFlowValidationError[]): void {
  if (!isRecord(probe) || !hasPresentString(probe, 'name')) {
    addError(errors, 'invalid_probe_step', `${path}.name`, 'probe.name must be a non-empty string')
    return
  }

  const name = probe['name'] as string
  if (!knownProbeNames.has(name)) {
    addError(errors, 'unknown_probe_name', `${path}.name`, `unknown probe name: ${name}`)
  }
}

function validateStepOutputRef(
  value: Record<string, unknown>,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[]
): void {
  const keys = Object.keys(value)
  const stepId = value['$step']
  const field = value['field']

  if (
    keys.some((key) => key !== '$step' && key !== 'field') ||
    typeof stepId !== 'string' ||
    stepId.length === 0 ||
    typeof field !== 'string' ||
    !isTopLevelFieldName(field)
  ) {
    addError(
      errors,
      'invalid_step_output_ref',
      path,
      'step-output ref must be an object with non-empty $step and top-level field'
    )
    return
  }

  if (!priorStepIds.has(stepId)) {
    addError(
      errors,
      'step_output_ref_unknown_step',
      `${path}.$step`,
      'step-output ref must name a prior step in the same phase'
    )
  }
}

function validateStringOrStepOutputRef(
  value: unknown,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[]
): boolean {
  if (typeof value === 'string') {
    return value.length > 0
  }
  if (isRecord(value)) {
    validateStepOutputRef(value, path, priorStepIds, errors)
    return true
  }
  return false
}

function validateAuthorityField(
  value: unknown,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[],
  stepErrorCode: JobFlowValidationErrorCode,
  missingMessage: string
): void {
  if (!validateStringOrStepOutputRef(value, path, priorStepIds, errors)) {
    addError(errors, stepErrorCode, path, missingMessage)
    return
  }

  if (typeof value === 'string' && containsTemplateInterpolation(value)) {
    addError(
      errors,
      'authority_field_interpolation',
      path,
      'authority fields must use literal values or step-output refs, not template interpolation'
    )
  }
}

function validateContentField(
  value: unknown,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[],
  stepErrorCode: JobFlowValidationErrorCode,
  missingMessage: string
): void {
  if (!validateStringOrStepOutputRef(value, path, priorStepIds, errors)) {
    addError(errors, stepErrorCode, path, missingMessage)
  }
}

function validateWrkqTaskStep(
  step: Record<string, unknown>,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[]
): void {
  validateContentField(
    step['title'],
    `${path}.title`,
    priorStepIds,
    errors,
    'invalid_wrkq_task_step',
    'wrkq-task step must include a non-empty title'
  )
  validateAuthorityField(
    step['container'],
    `${path}.container`,
    priorStepIds,
    errors,
    'invalid_wrkq_task_step',
    'wrkq-task step must include a non-empty container'
  )

  if ('description' in step) {
    validateContentField(
      step['description'],
      `${path}.description`,
      priorStepIds,
      errors,
      'invalid_wrkq_task_step',
      'wrkq-task description must be a non-empty string or step-output ref'
    )
  }

  if ('taskKind' in step && !hasPresentString(step, 'taskKind')) {
    addError(
      errors,
      'invalid_wrkq_task_step',
      `${path}.taskKind`,
      'wrkq-task taskKind must be a non-empty string'
    )
  }

  if (
    'labels' in step &&
    (!Array.isArray(step['labels']) ||
      step['labels'].some((entry) => typeof entry !== 'string' || entry.length === 0))
  ) {
    addError(
      errors,
      'invalid_wrkq_task_step',
      `${path}.labels`,
      'wrkq-task labels must be a string array'
    )
  }
}

function validatePulpitMessageStep(
  step: Record<string, unknown>,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[]
): void {
  validateContentField(
    step['content'],
    `${path}.content`,
    priorStepIds,
    errors,
    'invalid_pulpit_message_step',
    'pulpit-message step must include non-empty content'
  )
  validateAuthorityField(
    step['binding'],
    `${path}.binding`,
    priorStepIds,
    errors,
    'invalid_pulpit_message_step',
    'pulpit-message step must include a non-empty binding'
  )
}

function validateAgentDispatchStep(
  step: Record<string, unknown>,
  path: string,
  priorStepIds: ReadonlySet<string>,
  errors: JobFlowValidationError[]
): void {
  validateAuthorityField(
    step['scopeRef'],
    `${path}.scopeRef`,
    priorStepIds,
    errors,
    'invalid_agent_dispatch_step',
    'agent-dispatch step must include a non-empty scopeRef'
  )

  if ('agentId' in step) {
    validateAuthorityField(
      step['agentId'],
      `${path}.agentId`,
      priorStepIds,
      errors,
      'invalid_agent_dispatch_step',
      'agent-dispatch agentId must be a non-empty string or step-output ref'
    )
  }

  if ('projectId' in step) {
    validateAuthorityField(
      step['projectId'],
      `${path}.projectId`,
      priorStepIds,
      errors,
      'invalid_agent_dispatch_step',
      'agent-dispatch projectId must be a non-empty string or step-output ref'
    )
  }

  if ('laneRef' in step) {
    validateAuthorityField(
      step['laneRef'],
      `${path}.laneRef`,
      priorStepIds,
      errors,
      'invalid_agent_dispatch_step',
      'agent-dispatch laneRef must be a non-empty string or step-output ref'
    )
  }

  if ('input' in step) {
    const input = step['input']
    if (!isRecord(input)) {
      addError(
        errors,
        'invalid_agent_dispatch_step',
        `${path}.input`,
        'agent-dispatch input must be an object'
      )
    } else {
      for (const [key, value] of Object.entries(input)) {
        validateContentField(
          value,
          `${path}.input.${key}`,
          priorStepIds,
          errors,
          'invalid_agent_dispatch_step',
          'agent-dispatch input values must be non-empty strings or step-output refs'
        )
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
  priorStepIds: ReadonlySet<string>,
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
  if (kind !== undefined && (typeof kind !== 'string' || !allowedStepKinds.has(kind))) {
    addError(
      errors,
      'invalid_step_kind',
      `${path}.kind`,
      'step kind must be agent, exec, probe, wrkq-task, pulpit-message, or agent-dispatch'
    )
  }

  const stepKind = typeof kind === 'string' && allowedStepKinds.has(kind) ? kind : 'agent'

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

  if ('freshDuration' in step) {
    if (step['fresh'] !== true) {
      addError(
        errors,
        'invalid_fresh_duration',
        `${path}.freshDuration`,
        'freshDuration requires fresh=true'
      )
    }
    if (!isValidFreshDuration(step['freshDuration'])) {
      addError(
        errors,
        'invalid_fresh_duration',
        `${path}.freshDuration`,
        'freshDuration must be a positive fixed ISO 8601 duration using D, H, M, or S'
      )
    }
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
    validateBranchShape(step, path, stepKind, errors)
    return
  }

  if (stepKind === 'probe') {
    validateProbe(step['probe'], `${path}.probe`, errors)
    validateBranchShape(step, path, stepKind, errors)
    return
  }

  if (stepKind === 'wrkq-task') {
    validateWrkqTaskStep(step, path, priorStepIds, errors)
    return
  }

  if (stepKind === 'pulpit-message') {
    validatePulpitMessageStep(step, path, priorStepIds, errors)
    return
  }

  if (stepKind === 'agent-dispatch') {
    validateAgentDispatchStep(step, path, priorStepIds, errors)
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
  stepKind: string,
  errors: JobFlowValidationError[]
): void {
  if (!('branches' in step)) {
    if (stepKind === 'probe') {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.outcome`,
        'probe step must include branches.outcome'
      )
    }
    return
  }

  const branches = step['branches']
  if (!isRecord(branches)) {
    addError(errors, 'invalid_flow_next', `${path}.branches`, 'branches must be an object')
    return
  }

  if ('exitCode' in branches) {
    if (stepKind !== 'exec') {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.exitCode`,
        'probe steps must branch on outcome, not exitCode'
      )
      return
    }
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

  if ('outcome' in branches) {
    if (stepKind !== 'probe') {
      addError(
        errors,
        'invalid_flow_next',
        `${path}.branches.outcome`,
        'outcome branches are only supported on probe steps'
      )
      return
    }
    const outcome = branches['outcome']
    if (!isRecord(outcome)) {
      addError(
        errors,
        'invalid_probe_step',
        `${path}.branches.outcome`,
        'branches.outcome must be an object'
      )
    } else {
      for (const key of Object.keys(outcome)) {
        if (key !== 'idle' && key !== 'work') {
          addError(
            errors,
            'invalid_probe_step',
            `${path}.branches.outcome.${key}`,
            'probe outcome branches must be idle or work'
          )
        }
      }
      for (const key of ['idle', 'work'] as const) {
        const target = outcome[key]
        if (typeof target !== 'string') {
          addError(
            errors,
            'invalid_flow_next',
            `${path}.branches.outcome.${key}`,
            'branch target must be a terminal token or step id'
          )
        }
      }
    }
  }

  if (stepKind === 'probe' && !('outcome' in branches)) {
    addError(
      errors,
      'invalid_probe_step',
      `${path}.branches.outcome`,
      'probe step must include branches.outcome'
    )
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
  return isValidExitCodeNumber(exitCode)
}

function isValidExitCodeNumber(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return false
  }
  const exitCode = value
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

    if ((step['kind'] !== 'exec' && step['kind'] !== 'probe') || !isRecord(step['branches'])) {
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

    if (isRecord(branches['outcome'])) {
      for (const [outcome, target] of Object.entries(branches['outcome'])) {
        validateFlowNextTarget(target, `${path}.branches.outcome.${outcome}`, phaseStepIds, errors)
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

    if ((step['kind'] !== 'exec' && step['kind'] !== 'probe') || !isRecord(step['branches'])) {
      continue
    }

    const branches = step['branches']
    if (isRecord(branches['exitCode'])) {
      for (const target of Object.values(branches['exitCode'])) {
        addEdgeForFlowNext(edges, id, target, phaseStepIds)
      }
    }
    if (isRecord(branches['outcome'])) {
      for (const target of Object.values(branches['outcome'])) {
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

  const seenIds = new Map<string, string>()
  if (Array.isArray(sequence)) {
    const priorStepIds = new Set<string>()
    sequence.forEach((step, index) => {
      validateStep(step, 'sequence', index, options, seenIds, priorStepIds, errors)
      if (isRecord(step) && hasPresentString(step, 'id')) {
        priorStepIds.add(step['id'] as string)
      }
    })
  }

  const onFailure = flow['onFailure']
  if (onFailure !== undefined) {
    if (!Array.isArray(onFailure)) {
      addError(errors, 'invalid_step', 'flow.onFailure', 'flow.onFailure must be an array')
    } else {
      const priorStepIds = new Set<string>()
      onFailure.forEach((step, index) => {
        validateStep(step, 'onFailure', index, options, seenIds, priorStepIds, errors)
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
