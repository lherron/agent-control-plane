import { hasFlag, parseArgs, requireNoPositionals, requireStringFlag } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'

import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type JobRun = Record<string, unknown>
type JobRunsResponse = { jobRuns: JobRun[] }
type JobRunResponse = { jobRun: JobRun }

export async function runJobRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: ['--job', '--job-run', '--server', '--actor', '--project'],
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
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.jobRun))
  }

  throw new CliUsageError(`unknown job-run subcommand: ${subcommand}`)
}
