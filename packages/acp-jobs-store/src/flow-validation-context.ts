export type JobFlowValidationErrorCode =
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
  flow?: unknown
}

export type FlowPhase = 'sequence' | 'onFailure'
export type FlowPhaseSteps = Partial<Record<FlowPhase, unknown[]>>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasPresentString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return typeof value === 'string' && value.length > 0
}

export function addError(
  errors: JobFlowValidationError[],
  code: JobFlowValidationErrorCode,
  path: string,
  message: string
): void {
  errors.push({ code, path, message })
}
