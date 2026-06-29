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

type FlowSummary = {
  enabled: boolean
  stepCount: number
  freshStepCount: number
  freshDurationStepCount: number
}

type OperationalFacts = {
  jobId?: string | undefined
  bindingId?: string | undefined
  liveSlug?: string | undefined
  disabled?: boolean | undefined
  nextFireAt?: string | undefined
  flowSummary?: FlowSummary | undefined
  bindingTarget?:
    | {
        gatewayId: string
        conversationRef: string
        threadRef?: string | undefined
        scopeRef: string
        laneRef: string
      }
    | undefined
  hasDrift?: boolean | undefined
  driftKind?: string | undefined
}

type ApplyResponse = {
  outcomes: Array<
    OperationalFacts & {
      projectionId: string
      resourceKind: string
      projectionPk: string
      outcome: string
      error?: { code: string; message: string } | undefined
    }
  >
  stats: { created: number; updated: number; noop: number; failed: number }
}

type StatusResponse = {
  resources: Array<
    OperationalFacts & {
      projectionId: string
      resourceKind: string
      projectionPk: string
      state: string
      hasDrift: boolean
      driftKind?: string | undefined
    }
  >
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

function projectionIdsFromPlan(plan: ManagedResourcesPlan): string[] {
  if (!Array.isArray(plan.resources)) {
    throw new CliUsageError('plan.resources must be an array')
  }
  return plan.resources.map((resource, index) => {
    if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
      throw new CliUsageError(`plan.resources[${index}] must be an object`)
    }
    const projectionId = (resource as Record<string, unknown>)['projectionId']
    if (typeof projectionId !== 'string' || projectionId.trim().length === 0) {
      throw new CliUsageError(`plan.resources[${index}].projectionId must be a non-empty string`)
    }
    return projectionId.trim()
  })
}

function valueOrDash(value: string | undefined): string {
  return value === undefined || value.length === 0 ? '-' : value
}

function liveId(row: OperationalFacts): string {
  return valueOrDash(row.jobId ?? row.bindingId)
}

function disabledLabel(row: OperationalFacts): string {
  return row.disabled === undefined ? '-' : String(row.disabled)
}

function driftLabel(row: OperationalFacts): string {
  if (row.hasDrift === undefined) {
    return '-'
  }
  return row.hasDrift ? (row.driftKind ?? 'yes') : 'no'
}

function flowLabel(row: OperationalFacts): string {
  const flow = row.flowSummary
  if (flow === undefined) {
    return '-'
  }
  if (!flow.enabled) {
    return 'off'
  }
  return `${flow.stepCount} steps / ${flow.freshStepCount} fresh / ${flow.freshDurationStepCount} freshDuration`
}

function renderApplyText(response: ApplyResponse): string {
  const table = renderTable(
    [
      { header: 'Kind', value: (row: ApplyResponse['outcomes'][number]) => row.resourceKind },
      { header: 'Projection', value: (row) => row.projectionPk },
      { header: 'Live', value: liveId },
      { header: 'Outcome', value: (row) => row.outcome },
      { header: 'Next', value: (row) => valueOrDash(row.nextFireAt) },
      { header: 'Disabled', value: disabledLabel },
      { header: 'Drift', value: driftLabel },
      { header: 'Flow', value: flowLabel },
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
      { header: 'Live', value: liveId },
      { header: 'State', value: (row) => row.state },
      { header: 'Next', value: (row) => valueOrDash(row.nextFireAt) },
      { header: 'Disabled', value: disabledLabel },
      { header: 'Drift', value: driftLabel },
      { header: 'Flow', value: flowLabel },
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
  const projectionIds = projectionIdsFromPlan(plan)
  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<StatusResponse>({
    method: 'POST',
    path: '/v1/admin/managed-resources/status',
    body: { ownerScopeRef: ownerScopeRef.trim(), projectionIds },
  })
  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderStatusText(response))
}
