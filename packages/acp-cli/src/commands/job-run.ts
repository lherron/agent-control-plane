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

function renderStepsTable(steps: StepRecord[]): string {
  return renderTable(
    [
      { header: 'StepId', value: (row: StepRecord) => String(row['stepId'] ?? '') },
      { header: 'Phase', value: (row: StepRecord) => String(row['phase'] ?? '') },
      { header: 'Status', value: (row: StepRecord) => String(row['status'] ?? '') },
      { header: 'RunId', value: (row: StepRecord) => String(row['runId'] ?? '') },
      { header: 'Error', value: (row: StepRecord) => String(row['error'] ?? '') },
    ],
    steps
  )
}

function renderResultsTable(steps: StepRecord[]): string {
  return renderTable(
    [
      { header: 'StepId', value: (row: StepRecord) => String(row['stepId'] ?? '') },
      {
        header: 'Result',
        value: (row: StepRecord) => {
          const result = row['result']
          if (result === undefined || result === null) return ''
          return typeof result === 'string' ? result : JSON.stringify(result)
        },
      },
    ],
    steps
  )
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
      return { format: 'text', text: renderStepsTable(steps) }
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
