import type { ExecStepResult } from 'acp-core'
import type { JobStepRunRecord } from 'acp-jobs-store'

// Derives a failed job run's errorCode/errorMessage from its first failed
// sequence step: the step's own error, else an exec exit summary with the most
// useful output line.

const JOB_FAILURE_MESSAGE_MAX = 1024
const DIAGNOSTIC_LINE_PATTERN =
  /\b(error|fail(?:ed|ure)?|dirty|skipping|denied|timeout|timed out)\b/i

export function describeFailedStep(stepRun: JobStepRunRecord | undefined): {
  code: string
  message: string
} {
  if (stepRun === undefined) {
    return { code: 'job_flow_sequence_failed', message: 'job flow sequence failed' }
  }

  if (stepRun.error !== undefined) {
    return {
      code: stepRun.error.code,
      message: stepRun.error.message,
    }
  }

  const execResult = asExecStepResult(stepRun.result)
  if (execResult !== undefined) {
    const exitLabel =
      execResult.exitCode !== null
        ? `exit ${execResult.exitCode}`
        : execResult.signal !== undefined
          ? `signal ${execResult.signal}`
          : 'no exit code'
    const output = lastMeaningfulOutputLine(execResult)
    const detail =
      output !== undefined ? `exec step ${exitLabel}: ${output}` : `exec step ${exitLabel}`
    return {
      code: execResult.timedOut ? 'exec_timeout' : 'exec_exit_code',
      message: truncateFailureMessage(`${stepRun.phase} step ${stepRun.stepId} failed: ${detail}`),
    }
  }

  return {
    code: 'job_flow_sequence_failed',
    message: `${stepRun.phase} step ${stepRun.stepId} failed`,
  }
}

function asExecStepResult(value: unknown): ExecStepResult | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'exec') {
    return undefined
  }
  return record as unknown as ExecStepResult
}

function lastMeaningfulOutputLine(result: ExecStepResult): string | undefined {
  const stderr = nonEmptyLines(result.stderr)
  const stdout = nonEmptyLines(result.stdout)
  return (
    stderr.filter((line) => DIAGNOSTIC_LINE_PATTERN.test(line)).at(-1) ??
    stdout.filter((line) => DIAGNOSTIC_LINE_PATTERN.test(line)).at(-1) ??
    stderr.at(-1) ??
    stdout.at(-1) ??
    (result.stderrTruncated ? '[stderr truncated]' : undefined) ??
    (result.stdoutTruncated ? '[stdout truncated]' : undefined)
  )
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function truncateFailureMessage(value: string): string {
  return value.length > JOB_FAILURE_MESSAGE_MAX
    ? `${value.slice(0, JOB_FAILURE_MESSAGE_MAX - 3)}...`
    : value
}
