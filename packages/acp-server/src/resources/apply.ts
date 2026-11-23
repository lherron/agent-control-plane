import { type InterfaceStore, applyManagedBinding, detectBindingDrift } from 'acp-interface-store'
import { type JobsStore, applyManagedJob, detectJobDrift } from 'acp-jobs-store'
import { isRecord } from '../parsers/body.js'
import type { ManagedResourceProjection, ManagedResourcesPlan } from './plan.js'
import {
  type BindingTargetSummary,
  type FlowSummary,
  bindingOperationalFacts,
  driftFacts,
  jobOperationalFacts,
} from './projection.js'
import {
  discardApplyStores,
  openCachedInterfaceStore,
  openCachedJobsStore,
  prepareMemoryStoresForApply,
} from './stores.js'

export type ResourceOutcome = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  outcome:
    | 'created'
    | 'updated'
    | 'noop'
    | 'schedule_module_owned'
    | 'collision'
    | 'stale_adoption_rejected'
    | 'validation_error'
    | 'failed'
  jobId?: string | undefined
  bindingId?: string | undefined
  liveSlug?: string | undefined
  disabled?: boolean | undefined
  nextFireAt?: string | undefined
  flowSummary?: FlowSummary | undefined
  bindingTarget?: BindingTargetSummary | undefined
  hasDrift?: boolean | undefined
  driftKind?: string | undefined
  error?: { code: string; message: string } | undefined
}

export type ApplyManagedResourcesResult = {
  outcomes: ResourceOutcome[]
  stats: { created: number; updated: number; noop: number; failed: number }
}

export type ApplyManagedResourcesPlanInput = {
  plan: ManagedResourcesPlan
  jobsDbPath: string
  interfaceDbPath: string
  now: string
}

export type ApplyManagedResourcesWithStoresInput = {
  plan: ManagedResourcesPlan
  jobsStore: JobsStore
  interfaceStore: InterfaceStore
  now: string
}

function storeErrorFacts(result: unknown): Pick<ResourceOutcome, 'jobId' | 'bindingId' | 'error'> {
  if (!isRecord(result) || !isRecord(result['error'])) {
    return { error: undefined }
  }
  const error = result['error']
  const existingJobId = error['existingJobId']
  const existingBindingId = error['existingBindingId']
  let liveId: Pick<ResourceOutcome, 'jobId' | 'bindingId'> | undefined
  if (typeof existingJobId === 'string' && existingJobId.trim().length > 0) {
    liveId = { jobId: existingJobId }
  } else if (typeof existingBindingId === 'string' && existingBindingId.trim().length > 0) {
    liveId = { bindingId: existingBindingId }
  }
  return {
    ...liveId,
    error: {
      code: String(error['code'] ?? 'UNKNOWN_ERROR'),
      message: String(error['message'] ?? error['code'] ?? 'managed resource apply failed'),
    },
  }
}

function failedOutcome(error: unknown): Pick<ResourceOutcome, 'outcome' | 'error'> {
  return {
    outcome: 'failed',
    error: {
      code: 'APPLY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function statsFor(outcomes: readonly ResourceOutcome[]): ApplyManagedResourcesResult['stats'] {
  return {
    created: outcomes.filter((outcome) => outcome.outcome === 'created').length,
    updated: outcomes.filter((outcome) => outcome.outcome === 'updated').length,
    noop: outcomes.filter((outcome) => outcome.outcome === 'noop').length,
    failed: outcomes.filter(
      (outcome) =>
        outcome.outcome === 'collision' ||
        outcome.outcome === 'stale_adoption_rejected' ||
        outcome.outcome === 'validation_error' ||
        outcome.outcome === 'failed'
    ).length,
  }
}

export async function applyPlanWithStores(
  input: ApplyManagedResourcesWithStoresInput
): Promise<ApplyManagedResourcesResult> {
  const outcomes: ResourceOutcome[] = []

  for (const resource of input.plan.resources) {
    const base = {
      projectionId: resource.projectionId,
      resourceKind: resource.resourceKind,
      projectionPk: resource.projectionPk,
    }
    if (resource.resourceKind === 'scheduled-job') {
      outcomes.push({ ...base, outcome: 'schedule_module_owned' })
      continue
    }
    try {
      const applyInput = {
        projectionId: resource.projectionId,
        projectionPk: resource.projectionPk,
        sourceOwnerScopeRef: resource.sourceOwnerScopeRef,
        resourceName: resource.resourceName,
        sourcePath: resource.sourcePath,
        sourceHash: resource.sourceHash,
        desiredProjectionHash: resource.desiredProjectionHash,
        desiredJson: resource.desiredJson,
        now: input.now,
      }
      const result =
        resource.resourceKind === 'interface-binding'
          ? applyManagedBinding(input.interfaceStore, {
              ...applyInput,
              resourceKind: 'interface-binding',
            })
          : applyManagedJob(input.jobsStore, {
              ...applyInput,
              resourceKind: resource.resourceKind,
            })
      if ('job' in result) {
        const drift = detectJobDrift(input.jobsStore, resource.projectionId)
        outcomes.push({
          ...base,
          outcome: result.outcome,
          ...jobOperationalFacts(result.job),
          ...driftFacts(drift),
        })
        continue
      }
      if ('binding' in result) {
        const drift = detectBindingDrift(input.interfaceStore, resource.projectionId)
        outcomes.push({
          ...base,
          outcome: result.outcome,
          ...bindingOperationalFacts(result.binding),
          ...driftFacts(drift),
        })
        continue
      }
      outcomes.push({
        ...base,
        outcome: result.outcome,
        ...storeErrorFacts(result),
      })
    } catch (error) {
      outcomes.push({ ...base, ...failedOutcome(error) })
    }
  }

  return { outcomes, stats: statsFor(outcomes) }
}

export async function applyManagedResourcesPlan(
  input: ApplyManagedResourcesPlanInput
): Promise<ApplyManagedResourcesResult> {
  prepareMemoryStoresForApply(input)
  const jobsStore = openCachedJobsStore(input.jobsDbPath)
  const interfaceStore = openCachedInterfaceStore(input.interfaceDbPath)
  const result = await applyPlanWithStores({
    plan: input.plan,
    jobsStore,
    interfaceStore,
    now: input.now,
  })
  if (result.stats.failed > 0) {
    discardApplyStores(input)
  }
  return result
}
