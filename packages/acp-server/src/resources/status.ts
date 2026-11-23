import {
  type InterfaceStore,
  detectBindingDrift,
  listManagedBindingProvenances,
} from 'acp-interface-store'
import { type JobsStore, detectJobDrift, listManagedJobProvenances } from 'acp-jobs-store'
import type { ManagedResourceProjection, ManagedResourcesPlan } from './plan.js'
import {
  type BindingTargetSummary,
  type FlowSummary,
  bindingOperationalFacts,
  driftFacts,
  jobOperationalFacts,
} from './projection.js'
import type { SourceDeletionPolicy } from './reconcile.js'
import { openCachedInterfaceStore, openCachedJobsStore } from './stores.js'

export type RecommendedAction = 'none' | 'disable' | 'unsupported'

export type ManagedResourceStatusEntry = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  state: 'active' | 'disabled'
  hasDrift: boolean
  driftKind?: string | undefined
  jobId?: string | undefined
  bindingId?: string | undefined
  liveSlug?: string | undefined
  disabled?: boolean | undefined
  nextFireAt?: string | undefined
  flowSummary?: FlowSummary | undefined
  bindingTarget?: BindingTargetSummary | undefined
  // Provenance-backed report metadata (always populated for provenance rows).
  sourcePath?: string | undefined
  resourceName?: string | undefined
  liveTarget?: string | undefined
  // Plan-aware classification (only populated when status is plan-aware; the
  // owner-only form must NOT claim a stale classification it cannot know).
  isStale?: boolean | undefined
  recommendedAction?: RecommendedAction | undefined
  desiredProjectionHash?: string | undefined
}

export type GetManagedResourcesStatusInput =
  | {
      ownerScopeRef: string
      projectionIds?: string[] | undefined
      jobsDbPath: string
      interfaceDbPath: string
    }
  | {
      plan: ManagedResourcesPlan
      sourceDeletionPolicy?: SourceDeletionPolicy | undefined
      jobsDbPath: string
      interfaceDbPath: string
    }

export type GetManagedResourcesStatusResult = {
  resources: ManagedResourceStatusEntry[]
}

export type GetManagedResourcesStatusWithStoresInput =
  | {
      ownerScopeRef: string
      projectionIds?: string[] | undefined
      jobsStore: JobsStore
      interfaceStore: InterfaceStore
    }
  | {
      plan: ManagedResourcesPlan
      sourceDeletionPolicy?: SourceDeletionPolicy | undefined
      jobsStore: JobsStore
      interfaceStore: InterfaceStore
    }
function recommendedActionFor(
  isStale: boolean,
  state: 'active' | 'disabled',
  policy: SourceDeletionPolicy
): RecommendedAction {
  if (!isStale || state === 'disabled') {
    return 'none'
  }
  return policy === 'disable' ? 'disable' : 'unsupported'
}

export async function statusWithStores(
  input: GetManagedResourcesStatusWithStoresInput
): Promise<GetManagedResourcesStatusResult> {
  const planAware = 'plan' in input && input.plan !== undefined
  const ownerScopeRef = 'plan' in input ? input.plan.sourceOwnerScopeRef : input.ownerScopeRef
  const projectionIds = 'plan' in input ? undefined : input.projectionIds
  const policy: SourceDeletionPolicy =
    'plan' in input ? (input.sourceDeletionPolicy ?? 'disable') : 'disable'
  const presentProjectionIds =
    'plan' in input
      ? new Set(input.plan.resources.map((resource) => resource.projectionId))
      : undefined

  function planAwareFacts(
    projectionId: string,
    state: 'active' | 'disabled',
    scheduleModuleOwned = false
  ): Pick<ManagedResourceStatusEntry, 'isStale' | 'recommendedAction'> {
    if (!planAware || presentProjectionIds === undefined) {
      return {}
    }
    const isStale = !presentProjectionIds.has(projectionId)
    return {
      isStale,
      recommendedAction: scheduleModuleOwned
        ? 'none'
        : recommendedActionFor(isStale, state, policy),
    }
  }

  const jobResources: ManagedResourceStatusEntry[] = listManagedJobProvenances(input.jobsStore, {
    ownerScopeRef,
  }).map((provenance) => {
    const drift = detectJobDrift(input.jobsStore, provenance.projectionId)
    const job = input.jobsStore.getJob(provenance.jobId).job
    return {
      projectionId: provenance.projectionId,
      resourceKind: provenance.resourceKind,
      projectionPk: provenance.projectionPk,
      state: provenance.state,
      sourcePath: provenance.sourcePath,
      resourceName: provenance.resourceName,
      desiredProjectionHash: provenance.desiredProjectionHash,
      liveTarget: `job:${provenance.jobId}`,
      disabled: job === undefined ? provenance.state === 'disabled' : job.disabled,
      ...(job === undefined ? {} : jobOperationalFacts(job)),
      ...driftFacts(drift),
      ...planAwareFacts(
        provenance.projectionId,
        provenance.state,
        provenance.resourceKind === 'scheduled-job'
      ),
    }
  })
  const bindingResources: ManagedResourceStatusEntry[] = listManagedBindingProvenances(
    input.interfaceStore,
    { ownerScopeRef }
  ).map((provenance) => {
    const drift = detectBindingDrift(input.interfaceStore, provenance.projectionId)
    const binding = input.interfaceStore.bindings.getById(provenance.bindingId)
    return {
      projectionId: provenance.projectionId,
      resourceKind: provenance.resourceKind,
      projectionPk: provenance.projectionPk,
      state: provenance.state,
      sourcePath: provenance.sourcePath,
      resourceName: provenance.resourceName,
      desiredProjectionHash: provenance.desiredProjectionHash,
      liveTarget: `binding:${provenance.bindingId}`,
      disabled:
        binding === undefined ? provenance.state === 'disabled' : binding.status === 'disabled',
      ...(binding === undefined ? {} : bindingOperationalFacts(binding)),
      ...driftFacts(drift),
      ...planAwareFacts(provenance.projectionId, provenance.state),
    }
  })

  const resources = [...jobResources, ...bindingResources]
  if (projectionIds === undefined) {
    return { resources }
  }
  const byProjectionId = new Map(resources.map((resource) => [resource.projectionId, resource]))
  return {
    resources: projectionIds.flatMap((projectionId) => {
      const resource = byProjectionId.get(projectionId)
      return resource === undefined ? [] : [resource]
    }),
  }
}

export async function getManagedResourcesStatus(
  input: GetManagedResourcesStatusInput
): Promise<GetManagedResourcesStatusResult> {
  const jobsStore = openCachedJobsStore(input.jobsDbPath)
  const interfaceStore = openCachedInterfaceStore(input.interfaceDbPath)
  if ('plan' in input) {
    return statusWithStores({
      plan: input.plan,
      sourceDeletionPolicy: input.sourceDeletionPolicy,
      jobsStore,
      interfaceStore,
    })
  }
  return statusWithStores({
    ownerScopeRef: input.ownerScopeRef,
    projectionIds: input.projectionIds,
    jobsStore,
    interfaceStore,
  })
}
