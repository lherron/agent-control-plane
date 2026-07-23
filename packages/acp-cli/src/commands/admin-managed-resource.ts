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
  desiredProjectionHash?: string | undefined
  execution?:
    | {
        currentNode?: string | undefined
        mode?: 'single-node' | 'federated' | undefined
        ownerSet?: readonly string[] | undefined
        effectiveOwnerSet?: readonly string[] | undefined
        eligible: boolean
        eligibilityReason: string
        inflightCount: number
        localInflightCount?: number | undefined
        ownedButIncapable: readonly string[]
      }
    | undefined
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
      sourcePath?: string | undefined
      resourceName?: string | undefined
      liveTarget?: string | undefined
      isStale?: boolean | undefined
      recommendedAction?: string | undefined
    }
  >
}

type SourceDeletionPolicy = 'disable' | 'archive' | 'purge'

type SourceDeletionOutcome = {
  projectionId: string
  resourceKind: string
  projectionPk: string
  sourcePath: string
  resourceName: string
  liveTarget: string
  outcome: string
  previousState: string
  finalState: string
  hadDrift?: boolean | undefined
  driftKind?: string | undefined
  error?: { code: string; message: string } | undefined
}

type ReconcileResponse = {
  apply: ApplyResponse
  sourceDeletion: { outcomes: SourceDeletionOutcome[] }
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

function ownerSetLabel(row: OperationalFacts): string {
  if (row.execution === undefined) {
    return '-'
  }
  return row.execution.ownerSet?.join(',') ?? 'implicit'
}

function eligibilityLabel(row: OperationalFacts): string {
  const execution = row.execution
  if (execution === undefined) {
    return '-'
  }
  return execution.eligible ? 'yes' : execution.eligibilityReason
}

function capabilityLabel(row: OperationalFacts): string {
  return row.execution?.ownedButIncapable.join(',') || '-'
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

function staleLabel(row: StatusResponse['resources'][number]): string {
  return row.isStale === undefined ? '-' : String(row.isStale)
}

function recommendedActionLabel(row: StatusResponse['resources'][number]): string {
  return valueOrDash(row.recommendedAction)
}

function renderStatusText(response: StatusResponse): string {
  return renderTable(
    [
      { header: 'Kind', value: (row: StatusResponse['resources'][number]) => row.resourceKind },
      { header: 'Projection', value: (row) => row.projectionPk },
      { header: 'Live', value: liveId },
      { header: 'Source', value: (row) => valueOrDash(row.sourcePath) },
      { header: 'State', value: (row) => row.state },
      { header: 'Next', value: (row) => valueOrDash(row.nextFireAt) },
      { header: 'Disabled', value: disabledLabel },
      { header: 'Node', value: (row) => valueOrDash(row.execution?.currentNode) },
      { header: 'Owners', value: ownerSetLabel },
      { header: 'Eligible', value: eligibilityLabel },
      {
        header: 'Inflight',
        value: (row) =>
          row.execution === undefined
            ? '-'
            : String(row.execution.localInflightCount ?? row.execution.inflightCount),
      },
      { header: 'Capability', value: capabilityLabel },
      {
        header: 'Hash',
        value: (row) => valueOrDash(row.desiredProjectionHash?.slice(0, 12)),
      },
      { header: 'Drift', value: driftLabel },
      { header: 'Flow', value: flowLabel },
      { header: 'Stale', value: staleLabel },
      { header: 'Action', value: recommendedActionLabel },
    ],
    response.resources
  )
}

function renderReconcileText(response: ReconcileResponse): string {
  const apply = renderApplyText(response.apply)
  const outcomes = response.sourceDeletion.outcomes
  if (outcomes.length === 0) {
    return `${apply}\n\nsource-deletion: no stale resources`
  }
  const table = renderTable(
    [
      { header: 'Kind', value: (row: SourceDeletionOutcome) => row.resourceKind },
      { header: 'Projection', value: (row) => row.projectionPk },
      { header: 'Live', value: (row) => valueOrDash(row.liveTarget) },
      { header: 'Source', value: (row) => valueOrDash(row.sourcePath) },
      { header: 'Outcome', value: (row) => row.outcome },
      { header: 'From', value: (row) => row.previousState },
      { header: 'To', value: (row) => row.finalState },
    ],
    outcomes
  )
  return `${apply}\n\nsource-deletion:\n${table}`
}

function readSourceDeletionPolicy(parsed: ReturnType<typeof parseArgs>): SourceDeletionPolicy {
  const value = readStringFlag(parsed, '--source-deletion')
  if (value === undefined) {
    return 'disable'
  }
  if (value !== 'disable' && value !== 'archive' && value !== 'purge') {
    throw new CliUsageError('--source-deletion must be one of disable, archive, purge')
  }
  return value
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
  // Plan-aware status: the server compares the plan's projection ids against
  // existing provenance for plan.sourceOwnerScopeRef and reports stale resources
  // with recommended actions before any mutation.
  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<StatusResponse>({
    method: 'POST',
    path: '/v1/admin/managed-resources/status',
    body: { plan },
  })
  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderStatusText(response))
}

export async function runAdminManagedResourceReconcileCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json'],
    stringFlags: ['--in', '--server', '--actor', '--source-deletion'],
  })
  requireNoPositionals(parsed)
  const plan = requirePlan(parsed)
  const ownerScopeRef = plan.sourceOwnerScopeRef
  if (typeof ownerScopeRef !== 'string' || ownerScopeRef.trim().length === 0) {
    throw new CliUsageError('plan.sourceOwnerScopeRef must be a non-empty string')
  }
  const sourceDeletionPolicy = readSourceDeletionPolicy(parsed)
  const response = await createRawRequesterFromParsed(parsed, deps).requestJson<ReconcileResponse>({
    method: 'POST',
    path: '/v1/admin/managed-resources/reconcile',
    body: { plan, sourceDeletionPolicy },
  })
  return hasFlag(parsed, '--json') ? asJson(response) : asText(renderReconcileText(response))
}
