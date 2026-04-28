import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { CliUsageError } from '../cli-runtime.js'

type StepRecord = Record<string, unknown>
type JobFileBody = Record<string, unknown>

/**
 * Read `inputFile` from a step, resolve it relative to the job file directory,
 * read its contents, set step.input to the file contents, and remove inputFile.
 */
function resolveStepInputFile(step: StepRecord, jobDir: string): void {
  const inputFilePath = step['inputFile']
  if (inputFilePath === undefined) {
    return
  }

  if (typeof inputFilePath !== 'string' || inputFilePath.trim().length === 0) {
    throw new CliUsageError('inputFile must be a non-empty string')
  }

  const resolved = isAbsolute(inputFilePath) ? inputFilePath : join(jobDir, inputFilePath)

  let content: string
  try {
    content = readFileSync(resolved, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliUsageError(`failed to read inputFile "${resolved}": ${message}`)
  }

  step['input'] = content
  step['inputFile'] = undefined
}

function resolveStepArray(steps: unknown, jobDir: string): void {
  if (!Array.isArray(steps)) {
    return
  }
  for (const step of steps) {
    if (typeof step === 'object' && step !== null && !Array.isArray(step)) {
      resolveStepInputFile(step as StepRecord, jobDir)
    }
  }
}

/**
 * Load a job definition from a JSON file on disk.
 *
 * - Parses the file as JSON.
 * - Resolves any `inputFile` fields in `flow.sequence[*]` and `flow.onFailure[*]`
 *   by reading the referenced file relative to the job file's directory, inlining
 *   the content as `step.input`, and dropping `inputFile`.
 * - Returns the body object ready to POST/PATCH to the server.
 */
export function loadJobFile(jobFilePath: string): { body: JobFileBody } {
  let raw: string
  try {
    raw = readFileSync(jobFilePath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliUsageError(`failed to read job file "${jobFilePath}": ${message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliUsageError(`job file "${jobFilePath}" is not valid JSON`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`job file "${jobFilePath}" must contain a JSON object`)
  }

  const body = parsed as JobFileBody
  const jobDir = dirname(jobFilePath)

  const flow = body['flow']
  if (typeof flow === 'object' && flow !== null && !Array.isArray(flow)) {
    const flowRecord = flow as Record<string, unknown>
    resolveStepArray(flowRecord['sequence'], jobDir)
    resolveStepArray(flowRecord['onFailure'], jobDir)
  }

  return { body }
}
