import {
  type InterfaceStore,
  detectBindingDrift,
  disableManagedBinding,
  listManagedBindingProvenances,
} from 'acp-interface-store'
import {
  type JobsStore,
  detectJobDrift,
  disableManagedJob,
  listManagedJobProvenances,
} from 'acp-jobs-store'
import { type ApplyManagedResourcesResult, applyPlanWithStores } from './apply.js'
import {
  type ManagedResourceProjection,
  type ManagedResourcesPlan,
  validateManagedResourcesPlan,
} from './plan.js'
import {
  openCachedInterfaceStore,
  openCachedJobsStore,
  prepareMemoryStoresForApply,
} from './stores.js'

/**
 * Source-deletion policy for managed-resource reconciliation (T-05244).
 *
 * Default behavior is `disable` (disable-only): a stale event hook
 * or interface binding is disabled in place and its runtime/history rows
 * (jobs, provenance, event inbox/match/run history, bindings, delivery requests)
 * are preserved. No delete/purge happens by omission.
 *
 * `archive` and `purge` are reserved explicit wire values. They are NON-MUTATING
 * and UNSUPPORTED in v1 until a later architecture/spec defines resource-kind
 * semantics, history retention, and store migrations. They must never silently
 * degrade to `disable`; reconcile reports `stale_unsupported_action` and mutates
 * nothing. Unknown policy values are request validation errors.
 */
export type SourceDeletionPolicy = 'disable' | 'archive' | 'purge'

export type SourceDeletionOutcome = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  sourcePath: string
  resourceName: string
  liveTarget: string
  outcome: 'stale_disabled' | 'stale_noop' | 'stale_unsupported_action' | 'failed'
  previousState: 'active' | 'disabled'
  finalState: 'active' | 'disabled'
  hadDrift?: boolean | undefined
  driftKind?: string | undefined
  error?: { code: string; message: string } | undefined
}

export type ReconcileManagedResourcesResult = {
  apply: ApplyManagedResourcesResult
  sourceDeletion: { outcomes: SourceDeletionOutcome[] }
}

export type ReconcileManagedResourcesWithStoresInput = {
  plan: ManagedResourcesPlan
  jobsStore: JobsStore
  interfaceStore: InterfaceStore
  now: string
  sourceDeletionPolicy?: SourceDeletionPolicy | undefined
}

export type ReconcileManagedResourcesPlanInput = {
  plan: ManagedResourcesPlan
  jobsDbPath: string
  interfaceDbPath: string
  now: string
  sourceDeletionPolicy?: SourceDeletionPolicy | undefined
}

function reconcileStaleResource(
  provenance: Pick<
    SourceDeletionOutcome,
    'projectionId' | 'resourceKind' | 'projectionPk' | 'sourcePath' | 'resourceName'
  > & { state: SourceDeletionOutcome['previousState'] },
  liveTarget: string,
  drift: { hasDrift: boolean; driftKind?: string | undefined },
  policy: SourceDeletionPolicy,
  disable: () => void
): SourceDeletionOutcome {
  const base = {
    projectionId: provenance.projectionId,
    resourceKind: provenance.resourceKind,
    projectionPk: provenance.projectionPk,
    sourcePath: provenance.sourcePath,
    resourceName: provenance.resourceName,
    liveTarget,
    hadDrift: drift.hasDrift,
    driftKind: drift.driftKind,
  }
  if (policy !== 'disable') {
    return {
      ...base,
      outcome: 'stale_unsupported_action',
      previousState: provenance.state,
      finalState: provenance.state,
    }
  }
  if (provenance.state === 'disabled') {
    return { ...base, outcome: 'stale_noop', previousState: 'disabled', finalState: 'disabled' }
  }
  try {
    disable()
    return { ...base, outcome: 'stale_disabled', previousState: 'active', finalState: 'disabled' }
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      previousState: provenance.state,
      finalState: provenance.state,
      error: {
        code: 'SOURCE_DELETION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export async function reconcilePlanWithStores(
  input: ReconcileManagedResourcesWithStoresInput
): Promise<ReconcileManagedResourcesResult> {
  const policy: SourceDeletionPolicy = input.sourceDeletionPolicy ?? 'disable'

  // Reconcile v1 is apply-then-source-deletion. Apply the present resources
  // first using existing apply semantics.
  const apply = await applyPlanWithStores({
    plan: input.plan,
    jobsStore: input.jobsStore,
    interfaceStore: input.interfaceStore,
    now: input.now,
  })

  // Then compare the same plan against persisted provenance for the plan owner
  // and process stale (missing-source) resources under the requested policy.
  const ownerScopeRef = input.plan.sourceOwnerScopeRef
  const presentProjectionIds = new Set(
    input.plan.resources.map((resource) => resource.projectionId)
  )
  const outcomes: SourceDeletionOutcome[] = []

  for (const provenance of listManagedJobProvenances(input.jobsStore, { ownerScopeRef })) {
    if (
      provenance.resourceKind === 'scheduled-job' ||
      presentProjectionIds.has(provenance.projectionId)
    ) {
      continue
    }
    const { projectionId } = provenance
    const drift = detectJobDrift(input.jobsStore, projectionId)
    outcomes.push(
      reconcileStaleResource(provenance, `job:${provenance.jobId}`, drift, policy, () => {
        disableManagedJob(input.jobsStore, projectionId, 'source_missing')
      })
    )
  }
  for (const provenance of listManagedBindingProvenances(input.interfaceStore, { ownerScopeRef })) {
    if (presentProjectionIds.has(provenance.projectionId)) {
      continue
    }
    const { projectionId } = provenance
    const drift = detectBindingDrift(input.interfaceStore, projectionId)
    outcomes.push(
      reconcileStaleResource(provenance, `binding:${provenance.bindingId}`, drift, policy, () => {
        disableManagedBinding(input.interfaceStore, projectionId, 'source_missing')
      })
    )
  }

  return { apply, sourceDeletion: { outcomes } }
}

export async function reconcileManagedResourcesPlan(
  input: ReconcileManagedResourcesPlanInput
): Promise<ReconcileManagedResourcesResult> {
  const validation = validateManagedResourcesPlan(input.plan)
  if (!validation.valid) {
    throw new Error(
      `managed resources plan is invalid: ${validation.errors
        .map((error) => `${error.field}: ${error.message}`)
        .join('; ')}`
    )
  }
  prepareMemoryStoresForApply({
    jobsDbPath: input.jobsDbPath,
    interfaceDbPath: input.interfaceDbPath,
  })
  return reconcilePlanWithStores({
    plan: input.plan,
    jobsStore: openCachedJobsStore(input.jobsDbPath),
    interfaceStore: openCachedInterfaceStore(input.interfaceDbPath),
    now: input.now,
    sourceDeletionPolicy: input.sourceDeletionPolicy,
  })
}
