import {
  hasFlag,
  parseArgs,
  parseJsonObject,
  requireNoPositionals,
  requireStringFlag,
} from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'

import {
  type CommandDependencies,
  type CommandOutput,
  createRawRequesterFromParsed,
  renderJsonOrTable,
} from './shared.js'

type JobRecord = Record<string, unknown>
type JobListResponse = { jobs: JobRecord[] }
type JobShowResponse = { job: JobRecord }
type JobRunResponse = { jobRun: Record<string, unknown> }

function renderJobsTable(response: JobListResponse): string {
  return renderTable(
    [
      { header: 'Job', value: (row: JobRecord) => String(row['jobId'] ?? '') },
      { header: 'Project', value: (row: JobRecord) => String(row['projectId'] ?? '') },
      { header: 'Agent', value: (row: JobRecord) => String(row['agentId'] ?? '') },
      { header: 'Lane', value: (row: JobRecord) => String(row['laneRef'] ?? '') },
      { header: 'Disabled', value: (row: JobRecord) => String(row['disabled'] ?? '') },
    ],
    response.jobs
  )
}

export async function runJobCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(rest, {
    booleanFlags: ['--json', '--table', '--disabled', '--enabled'],
    stringFlags: [
      '--job',
      '--project',
      '--agent',
      '--scope-ref',
      '--lane-ref',
      '--cron',
      '--input',
      '--server',
      '--actor',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('job help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)
  const requester = createRawRequesterFromParsed(parsed, deps)

  if (subcommand === 'create') {
    const body = {
      ...(parsed.stringFlags['--job'] !== undefined
        ? { jobId: requireStringFlag(parsed, '--job') }
        : {}),
      projectId: requireStringFlag(parsed, '--project'),
      agentId: requireStringFlag(parsed, '--agent'),
      scopeRef: requireStringFlag(parsed, '--scope-ref'),
      ...(parsed.stringFlags['--lane-ref'] !== undefined
        ? { laneRef: requireStringFlag(parsed, '--lane-ref') }
        : {}),
      schedule: { cron: requireStringFlag(parsed, '--cron') },
      input: parseJsonObject('--input', requireStringFlag(parsed, '--input')),
      ...(hasFlag(parsed, '--disabled') ? { disabled: true } : {}),
    }
    const response = await requester.requestJson<JobShowResponse>({
      method: 'POST',
      path: '/v1/admin/jobs',
      body,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.job))
  }

  if (subcommand === 'list') {
    const query = new URLSearchParams()
    if (parsed.stringFlags['--project'] !== undefined) {
      query.set('projectId', requireStringFlag(parsed, '--project'))
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await requester.requestJson<JobListResponse>({
      method: 'GET',
      path: `/v1/admin/jobs${suffix}`,
    })
    return renderJsonOrTable(parsed, response, () => renderJobsTable(response))
  }

  if (subcommand === 'show') {
    const response = await requester.requestJson<JobShowResponse>({
      method: 'GET',
      path: `/v1/admin/jobs/${encodeURIComponent(requireStringFlag(parsed, '--job'))}`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.job))
  }

  if (subcommand === 'patch') {
    const patch: Record<string, unknown> = {}
    if (parsed.stringFlags['--cron'] !== undefined) {
      patch['schedule'] = { cron: requireStringFlag(parsed, '--cron') }
    }
    if (parsed.stringFlags['--input'] !== undefined) {
      patch['input'] = parseJsonObject('--input', requireStringFlag(parsed, '--input'))
    }
    if (hasFlag(parsed, '--disabled') && hasFlag(parsed, '--enabled')) {
      throw new CliUsageError('choose either --disabled or --enabled')
    }
    if (hasFlag(parsed, '--disabled')) {
      patch['disabled'] = true
    }
    if (hasFlag(parsed, '--enabled')) {
      patch['disabled'] = false
    }
    if (Object.keys(patch).length === 0) {
      throw new CliUsageError('job patch requires at least one patch field')
    }

    const response = await requester.requestJson<JobShowResponse>({
      method: 'PATCH',
      path: `/v1/admin/jobs/${encodeURIComponent(requireStringFlag(parsed, '--job'))}`,
      body: patch,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.job))
  }

  if (subcommand === 'run') {
    const response = await requester.requestJson<JobRunResponse>({
      method: 'POST',
      path: `/v1/admin/jobs/${encodeURIComponent(requireStringFlag(parsed, '--job'))}/run`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.jobRun))
  }

  throw new CliUsageError(`unknown job subcommand: ${subcommand}`)
}
