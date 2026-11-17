import { isValidExitCodeNumber, validateBranchShape } from './flow-graph-validation.js'
import {
  type FlowPhase,
  type JobFlowValidationError,
  type JobFlowValidationErrorCode,
  type ValidateJobFlowOptions,
  addError,
  hasPresentString,
  isRecord,
} from './flow-validation-context.js'
import { isValidFreshDuration } from './fresh-duration.js'

const allowedExpectationFields = new Set(['outcome', 'resultBlock', 'require', 'equals'])
const allowedOutcomes = new Set(['succeeded', 'failed', 'cancelled'])
const allowedStepKinds = new Set([
  'agent',
  'exec',
  'probe',
  'wrkq-task',
  'pulpit-message',
  'agent-dispatch',
])
const knownProbeNames = new Set([
  'hrc-stale-tty-reap.v1',
  'wrkq-refactor-eligible.v1',
  'hrc-event-local-node.v1',
])
const maxExecOutputBytes = 64 * 1024 * 1024

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
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

  for (const field of ['agentId', 'projectId', 'laneRef'] as const) {
    if (field in step) {
      validateAuthorityField(
        step[field],
        `${path}.${field}`,
        priorStepIds,
        errors,
        'invalid_agent_dispatch_step',
        `agent-dispatch ${field} must be a non-empty string or step-output ref`
      )
    }
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

export function validateStep(
  step: unknown,
  phase: FlowPhase,
  index: number,
  options: ValidateJobFlowOptions,
  seenIds: Set<string>,
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
    if (seenIds.has(id)) {
      addError(errors, 'duplicate_step_id', `${path}.id`, `duplicate step id: ${id}`)
    } else {
      seenIds.add(id)
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
    validateExec(step['exec'], `${path}.exec`, errors)
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
