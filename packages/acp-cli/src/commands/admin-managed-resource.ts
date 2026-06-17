import { readFileSync } from 'node:fs'

import { CliUsageError } from '../cli-runtime.js'
import { renderTable } from '../output/table.js'
import { hasFlag, parseArgs, readStringFlag, requireNoPositionals } from './options.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  createRawRequesterFromParsed,
} from './shared.js'

type ManagedResourcesPlan = {
  sourceOwnerScopeRef?: unknown
  resources?: unknown
}

type ApplyResponse = {
  outcomes: Array<{
    projectionId: string
    resourceKind: string
    projectionPk: string
    outcome: string
    error?: { code: string; message: string } | undefined
  }>
  stats: { created: number; updated: number; noop: number; failed: number }
}

type StatusResponse = {
  resources: Array<{
    projectionId: string
    resourceKind: string
    projectionPk: string
    state: string
    hasDrift: boolean
    driftKind?: string | undefined
  }>
}

function loadPlanFile(path: string): ManagedResourcesPlan {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`failed to read managed resource plan "${path}": ${message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliUsageError(`managed resource plan "${path}" is not valid JSON`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`managed resource plan "${path}" must contain a JSON object`)
  }
  return parsed as ManagedResourcesPlan
}

function requirePlan(parsed: ReturnType<typeof parseArgs>): ManagedResourcesPlan {
  const path = readStringFlag(parsed, '--in')
  if (path === undefined || path.trim().length === 0) {
    throw new CliUsageError('--in <plan.json> is required')
  }
  return loadPlanFile(path)
}

function renderApplyText(response: ApplyResponse): string {
  const table = renderTable(
    [
      { header: 'Kind', value: (row: ApplyResponse['outcomes'][number]) => row.resourceKind },
      { header: 'Projection', value: (row) => row.projectionPk },
      { header: 'Outcome', value: (row) => row.outcome },
      { header: 'Error', value: (row) => row.error?.code ?? '' },
    ],
    response.outcomes
  )
  return `${table}\ncreated ${response.stats.created} / updated ${response.stats.updated} / noop ${response.stats.noop} / failed ${response.stats.failed}`
}

function renderStatusText(response: StatusResponse): string {
  return renderTable(
    [
      { header: 'Kind', value: (row: StatusResponse['resources'][number]) => row.resourceKind },
      { header: 'Projection', value: (row) => row.projectionPk },
      { header: 'State', value: (row) => row.state },
      { header: 'Drift', value: (row) => (row.hasDrift ? (row.driftKind ?? 'yes') : 'no') },
    ],
    response.resources
  )
}

export async function runAdminManagedResourceApplyCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--in', '--server', '--actor'],
  })
  requireNoPositionals(parsed)
  const plan = requirePlan(parsed)
  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<ApplyResponse>({
    method: 'POST',
    path: '/v1/admin/managed-resources/apply',
    body: { plan },
  })
  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderApplyText(response))
}

export async function runAdminManagedResourceStatusCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--in', '--server', '--actor'],
  })
  requireNoPositionals(parsed)
  const plan = requirePlan(parsed)
  const ownerScopeRef = plan.sourceOwnerScopeRef
  if (typeof ownerScopeRef !== 'string' || ownerScopeRef.trim().length === 0) {
    throw new CliUsageError('plan.sourceOwnerScopeRef must be a non-empty string')
  }
  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<StatusResponse>({
    method: 'POST',
    path: '/v1/admin/managed-resources/status',
    body: { ownerScopeRef: ownerScopeRef.trim() },
  })
  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderStatusText(response))
}
