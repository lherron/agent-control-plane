import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'
import {
  hasFlag,
  parseArgs,
  parseDurationMs,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'
import { pollJobRun } from './poll.js'

import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type JobRun = Record<string, unknown>
type JobRunsResponse = { jobRuns: JobRun[] }
type JobRunResponse = { jobRun: JobRun }

/** Default poll interval: 1 second. */
const DEFAULT_POLL_INTERVAL_MS = 1_000
/** Default timeout: 10 minutes. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000

function readOptionalDuration(
  parsed: ReturnType<typeof parseArgs>,
  flag: string
): number | undefined {
  const raw = parsed.stringFlags[flag]
  return raw === undefined ? undefined : parseDurationMs(flag, raw, { min: 1 })
}

type StepRecord = Record<string, unknown>

const OUTPUT_PREVIEW_CHARS = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function readExecResult(row: StepRecord): Record<string, unknown> | undefined {
  const result = row['result']
  if (!isRecord(result) || result['kind'] !== 'exec') return undefined
  return result
}

function renderBooleanFlag(value: unknown): string {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return ''
}

function renderExecResultValue(row: StepRecord, key: string): string {
  const result = readExecResult(row)
  if (result === undefined) return ''
  return stringifyCell(result[key])
}

function compactOutput(value: unknown): { text: string; truncated: boolean } {
  if (typeof value !== 'string' || value.length === 0) {
    return { text: '', truncated: false }
  }

  const sanitized = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  if (sanitized.length <= OUTPUT_PREVIEW_CHARS) {
    return { text: sanitized, truncated: false }
  }

  return {
    text: `${sanitized.slice(0, OUTPUT_PREVIEW_CHARS)}... [display truncated; ${sanitized.length} chars stored]`,
    truncated: true,
  }
}

function renderOutputCell(row: StepRecord, key: 'stdout' | 'stderr'): string {
  const result = readExecResult(row)
  return compactOutput(result?.[key]).text
}

function hasDisplayTruncatedOutput(steps: StepRecord[]): boolean {
  return steps.some((step) => {
    const result = readExecResult(step)
    return (
      compactOutput(result?.['stdout']).truncated || compactOutput(result?.['stderr']).truncated
    )
  })
}

function hasStoredTruncatedOutput(steps: StepRecord[]): boolean {
  return steps.some((step) => {
    const result = readExecResult(step)
    return result?.['stdoutTruncated'] === true || result?.['stderrTruncated'] === true
  })
}

function appendOutputNotes(text: string, steps: StepRecord[]): string {
  const notes: string[] = []
  if (hasDisplayTruncatedOutput(steps)) {
    notes.push(
      'Output columns are truncated for display; use --json for full captured stdout/stderr.'
    )
  }
  if (hasStoredTruncatedOutput(steps)) {
    notes.push('StdoutTrunc/StderrTrunc=true means captured output exceeded the stored result cap.')
  }

  return notes.length === 0 ? text : `${text}\n\n${notes.join('\n')}`
}

function renderStepsTable(steps: StepRecord[], options: { includeResults?: boolean } = {}): string {
  const columns = [
    { header: 'StepId', value: (row: StepRecord) => String(row['stepId'] ?? '') },
    { header: 'Phase', value: (row: StepRecord) => String(row['phase'] ?? '') },
    { header: 'Status', value: (row: StepRecord) => String(row['status'] ?? '') },
    { header: 'ExitCode', value: (row: StepRecord) => renderExecResultValue(row, 'exitCode') },
    { header: 'DurationMs', value: (row: StepRecord) => renderExecResultValue(row, 'durationMs') },
    {
      header: 'StdoutTrunc',
      value: (row: StepRecord) => renderBooleanFlag(readExecResult(row)?.['stdoutTruncated']),
    },
    {
      header: 'StderrTrunc',
      value: (row: StepRecord) => renderBooleanFlag(readExecResult(row)?.['stderrTruncated']),
    },
    { header: 'RunId', value: (row: StepRecord) => String(row['runId'] ?? '') },
    { header: 'Error', value: (row: StepRecord) => stringifyCell(row['error']) },
  ]

  if (options.includeResults === true) {
    columns.push(
      { header: 'Stdout', value: (row: StepRecord) => renderOutputCell(row, 'stdout') },
      { header: 'Stderr', value: (row: StepRecord) => renderOutputCell(row, 'stderr') }
    )
  }

  const table = renderTable(columns, steps)
  return options.includeResults === true ? appendOutputNotes(table, steps) : table
}

function renderResultSummary(row: StepRecord): string {
  const result = row['result']
  if (result === undefined || result === null) return ''
  if (readExecResult(row) !== undefined) return 'exec'
  return stringifyCell(result)
}

function renderResultsTable(steps: StepRecord[]): string {
  const table = renderTable(
    [
      { header: 'StepId', value: (row: StepRecord) => String(row['stepId'] ?? '') },
      { header: 'ExitCode', value: (row: StepRecord) => renderExecResultValue(row, 'exitCode') },
      {
        header: 'DurationMs',
        value: (row: StepRecord) => renderExecResultValue(row, 'durationMs'),
      },
      { header: 'Stdout', value: (row: StepRecord) => renderOutputCell(row, 'stdout') },
      { header: 'Stderr', value: (row: StepRecord) => renderOutputCell(row, 'stderr') },
      { header: 'Result', value: renderResultSummary },
    ],
    steps
  )

  return appendOutputNotes(table, steps)
}

export async function runJobRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table', '--steps', '--results'],
    stringFlags: [
      '--job',
      '--job-run',
      '--server',
      '--actor',
      '--project',
      '--poll-interval',
      '--timeout',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('job-run help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)
  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'list') {
    const response = await requester.requestJson<JobRunsResponse>({
      method: 'GET',
      path: `/v1/jobs/${encodeURIComponent(requireStringFlag(parsed, '--job'))}/runs`,
    })
    return renderJsonOrTable(parsed, response, () => {
      return renderTable(
        [
          { header: 'JobRun', value: (row: JobRun) => String(row['jobRunId'] ?? '') },
          { header: 'Job', value: (row: JobRun) => String(row['jobId'] ?? '') },
          { header: 'Status', value: (row: JobRun) => String(row['status'] ?? '') },
          { header: 'Run', value: (row: JobRun) => String(row['runId'] ?? '') },
        ],
        response.jobRuns
      )
    })
  }

  if (subcommand === 'show') {
    const response = await requester.requestJson<JobRunResponse>({
      method: 'GET',
      path: `/v1/job-runs/${encodeURIComponent(requireStringFlag(parsed, '--job-run'))}`,
    })

    // --steps: render steps[] table
    if (hasFlag(parsed, '--steps') && !hasFlag(parsed, '--json')) {
      const steps = (response.jobRun['steps'] as StepRecord[] | undefined) ?? []
      return {
        format: 'text',
        text: renderStepsTable(steps, { includeResults: hasFlag(parsed, '--results') }),
      }
    }

    // --results: render step results table
    if (hasFlag(parsed, '--results') && !hasFlag(parsed, '--json')) {
      const steps = (response.jobRun['steps'] as StepRecord[] | undefined) ?? []
      return { format: 'text', text: renderResultsTable(steps) }
    }

    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.jobRun))
  }

  if (subcommand === 'wait') {
    const jobRunId = requireStringFlag(parsed, '--job-run')
    const intervalMs = readOptionalDuration(parsed, '--poll-interval') ?? DEFAULT_POLL_INTERVAL_MS
    const timeoutMs = readOptionalDuration(parsed, '--timeout') ?? DEFAULT_TIMEOUT_MS

    const result = await pollJobRun(requester, jobRunId, {
      intervalMs,
      timeoutMs,
    })

    const body = {
      jobRun: result.latest,
      ...(result.timedOut ? { timedOut: true } : {}),
    }

    return renderJsonOrTable(parsed, body, () => {
      return renderKeyValueTable({
        jobRunId: String(result.latest['jobRunId'] ?? ''),
        status: String(result.latest['status'] ?? ''),
        ...(result.timedOut ? { timedOut: 'true' } : {}),
      })
    })
  }

  throw new CliUsageError(`unknown job-run subcommand: ${subcommand}`)
}
