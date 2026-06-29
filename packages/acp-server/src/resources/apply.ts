import {
  type InterfaceBinding,
  type InterfaceStore,
  applyManagedBinding,
  detectBindingDrift,
  listManagedBindingProvenances,
  openInterfaceStore,
} from 'acp-interface-store'
import {
  type JobRecord,
  type JobsStore,
  applyManagedJob,
  detectJobDrift,
  listManagedJobProvenances,
  openSqliteJobsStore,
} from 'acp-jobs-store'

import { validateJobOutputConfig } from '../jobs/job-output-config.js'

// ---------------------------------------------------------------------------
// Types (API contract frozen by Phase C RED tests)
// ---------------------------------------------------------------------------

export type ManagedResourceProjection = {
  projectionId: string
  resourceKind: 'scheduled-job' | 'event-hook' | 'interface-binding'
  projectionTable: 'jobs' | 'interface_bindings'
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  sourceVersion: 1
  managedBy: 'agent-directory'
  origin: 'created'
  lastReconciledAt: 'pending-apply'
  createdAt: 'pending-apply'
  updatedAt: 'pending-apply'
}

export type ManagedResourcesPlan = {
  schema: 'agent-authored-runtime-resources.plan/v1'
  sourceOwnerScopeRef: string
  managedBy: 'agent-directory'
  compiler: { name: 'spaces-config/resources'; version: 1 }
  resources: ManagedResourceProjection[]
}

export type ResourceOutcome = {
  projectionId: string
  resourceKind: ManagedResourceProjection['resourceKind']
  projectionPk: string
  outcome:
    | 'created'
    | 'updated'
    | 'noop'
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

export type PlanValidationResult =
  | { valid: true }
  | { valid: false; errors: Array<{ field: string; message: string }> }

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
}

export type GetManagedResourcesStatusInput = {
  ownerScopeRef: string
  projectionIds?: string[] | undefined
  jobsDbPath: string
  interfaceDbPath: string
}

export type GetManagedResourcesStatusResult = {
  resources: ManagedResourceStatusEntry[]
}

export type ApplyManagedResourcesWithStoresInput = {
  plan: ManagedResourcesPlan
  jobsStore: JobsStore
  interfaceStore: InterfaceStore
  now: string
}

export type GetManagedResourcesStatusWithStoresInput = {
  ownerScopeRef: string
  projectionIds?: string[] | undefined
  jobsStore: JobsStore
  interfaceStore: InterfaceStore
}

export type FlowSummary = {
  enabled: boolean
  stepCount: number
  freshStepCount: number
  freshDurationStepCount: number
}

export type BindingTargetSummary = {
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  scopeRef: string
  laneRef: string
}

const HASH_RE = /^sha256-canonical-json\/v1:[0-9a-f]{64}$/

const PLAN_KEYS = new Set(['schema', 'sourceOwnerScopeRef', 'managedBy', 'compiler', 'resources'])
const COMPILER_KEYS = new Set(['name', 'version'])
const RESOURCE_KEYS = new Set([
  'projectionId',
  'resourceKind',
  'projectionTable',
  'projectionPk',
  'sourceOwnerScopeRef',
  'resourceName',
  'sourcePath',
  'sourceHash',
  'desiredProjectionHash',
  'desiredJson',
  'sourceVersion',
  'managedBy',
  'origin',
  'lastReconciledAt',
  'createdAt',
  'updatedAt',
])
const RESOURCE_KINDS = new Set(['scheduled-job', 'event-hook', 'interface-binding'])

type StoreCacheEntry =
  | { type: 'jobs'; store: JobsStore }
  | { type: 'interface'; store: InterfaceStore }

const storeCache = new Map<string, StoreCacheEntry>()
let activeMemoryApplyInput: ApplyManagedResourcesPlanInput | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addError(
  errors: Array<{ field: string; message: string }>,
  field: string,
  message: string
): void {
  errors.push({ field, message })
}

function unknownFieldErrors(
  errors: Array<{ field: string; message: string }>,
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      addError(errors, `${prefix}.${key}`, 'unknown field')
    }
  }
}

function requireString(
  errors: Array<{ field: string; message: string }>,
  input: Record<string, unknown>,
  key: string,
  field = key
): void {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    addError(errors, field, 'must be a non-empty string')
  }
}

function validateOriginPolicy(
  errors: Array<{ field: string; message: string }>,
  resource: Record<string, unknown>,
  index: number
): void {
  const desiredJson = resource['desiredJson']
  if (!isRecord(desiredJson)) {
    return
  }
  const trigger = desiredJson['trigger']
  if (!isRecord(trigger)) {
    return
  }
  const originPolicy = trigger['originPolicy']
  if (isRecord(originPolicy) && originPolicy['agent'] === 'allow') {
    addError(
      errors,
      `resources[${index}].desiredJson.trigger.originPolicy.agent`,
      "originPolicy.agent='allow' is rejected in v1"
    )
  }
}

function validateDesiredOutput(
  errors: Array<{ field: string; message: string }>,
  resource: Record<string, unknown>,
  index: number
): void {
  const desiredJson = resource['desiredJson']
  if (!isRecord(desiredJson) || desiredJson['output'] === undefined) {
    return
  }
  const validation = validateJobOutputConfig(desiredJson['output'])
  if (!validation.valid) {
    addError(errors, `resources[${index}].desiredJson.output`, validation.errors.join('; '))
  }
  if (desiredJson['flow'] !== undefined) {
    addError(
      errors,
      `resources[${index}].desiredJson.output`,
      'output is only supported for non-flow jobs'
    )
  }
}

function openCachedJobsStore(dbPath: string): JobsStore {
  const key = `jobs::${dbPath}`
  const cached = storeCache.get(key)
  if (cached?.type === 'jobs') {
    return cached.store
  }
  const store = openSqliteJobsStore({ dbPath })
  storeCache.set(key, { type: 'jobs', store })
  return store
}

function openCachedInterfaceStore(dbPath: string): InterfaceStore {
  const key = `iface::${dbPath}`
  const cached = storeCache.get(key)
  if (cached?.type === 'interface') {
    return cached.store
  }
  const store = openInterfaceStore({ dbPath })
  storeCache.set(key, { type: 'interface', store })
  return store
}

function evictCachedStore(type: 'jobs' | 'iface', dbPath: string): void {
  const key = `${type}::${dbPath}`
  const cached = storeCache.get(key)
  cached?.store.close()
  storeCache.delete(key)
}

function prepareMemoryStoresForApply(input: ApplyManagedResourcesPlanInput): void {
  if (input.jobsDbPath !== ':memory:' && input.interfaceDbPath !== ':memory:') {
    return
  }
  if (activeMemoryApplyInput === input) {
    return
  }
  if (input.jobsDbPath === ':memory:') {
    evictCachedStore('jobs', input.jobsDbPath)
  }
  if (input.interfaceDbPath === ':memory:') {
    evictCachedStore('iface', input.interfaceDbPath)
  }
  activeMemoryApplyInput = input
}

function errorFromResult(result: unknown): { code: string; message: string } | undefined {
  if (!isRecord(result) || !isRecord(result['error'])) {
    return undefined
  }
  const error = result['error']
  return {
    code: String(error['code'] ?? 'UNKNOWN_ERROR'),
    message: String(error['message'] ?? error['code'] ?? 'managed resource apply failed'),
  }
}

function liveIdFromResult(
  result: unknown
): Pick<ResourceOutcome, 'jobId' | 'bindingId'> | undefined {
  if (!isRecord(result) || !isRecord(result['error'])) {
    return undefined
  }
  const error = result['error']
  const existingJobId = error['existingJobId']
  if (typeof existingJobId === 'string' && existingJobId.trim().length > 0) {
    return { jobId: existingJobId }
  }
  const existingBindingId = error['existingBindingId']
  if (typeof existingBindingId === 'string' && existingBindingId.trim().length > 0) {
    return { bindingId: existingBindingId }
  }
  return undefined
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

function summarizeJobFlow(job: JobRecord): FlowSummary {
  const sequence = job.flow?.sequence ?? []
  const onFailure = job.flow?.onFailure ?? []
  const steps = [...sequence, ...onFailure]
  return {
    enabled: job.flow !== undefined,
    stepCount: steps.length,
    freshStepCount: steps.filter((step) => step.fresh === true).length,
    freshDurationStepCount: steps.filter(
      (step) => typeof step.freshDuration === 'string' && step.freshDuration.trim().length > 0
    ).length,
  }
}

function jobOperationalFacts(
  job: JobRecord
): Pick<ResourceOutcome, 'jobId' | 'liveSlug' | 'disabled' | 'nextFireAt' | 'flowSummary'> {
  return {
    jobId: job.jobId,
    liveSlug: job.slug,
    disabled: job.disabled,
    nextFireAt: job.nextFireAt,
    flowSummary: summarizeJobFlow(job),
  }
}

function compactBindingScopeRef(binding: InterfaceBinding): string {
  if (binding.agentId === undefined || binding.projectId === undefined) {
    return binding.scopeRef
  }
  const taskSegment = binding.taskId === undefined ? '' : `:task:${binding.taskId}`
  return `agent:${binding.agentId}:project:${binding.projectId}${taskSegment}`
}

function bindingOperationalFacts(
  binding: InterfaceBinding
): Pick<ResourceOutcome, 'bindingId' | 'disabled' | 'bindingTarget'> {
  return {
    bindingId: binding.bindingId,
    disabled: binding.status === 'disabled',
    bindingTarget: {
      gatewayId: binding.gatewayId,
      conversationRef: binding.conversationRef,
      threadRef: binding.threadRef,
      scopeRef: compactBindingScopeRef(binding),
      laneRef: binding.laneRef,
    },
  }
}

function driftFacts(drift: { hasDrift: boolean; driftKind?: string | undefined }): {
  hasDrift: boolean
  driftKind?: string | undefined
} {
  return {
    hasDrift: drift.hasDrift,
    driftKind: drift.driftKind,
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

export function validateManagedResourcesPlan(rawPlan: unknown): PlanValidationResult {
  const errors: Array<{ field: string; message: string }> = []

  if (!isRecord(rawPlan)) {
    return { valid: false, errors: [{ field: 'plan', message: 'must be a JSON object' }] }
  }

  unknownFieldErrors(errors, rawPlan, PLAN_KEYS, 'plan')
  if (rawPlan['schema'] !== 'agent-authored-runtime-resources.plan/v1') {
    addError(errors, 'schema', 'must be agent-authored-runtime-resources.plan/v1')
  }
  if (rawPlan['managedBy'] !== 'agent-directory') {
    addError(errors, 'managedBy', 'must be agent-directory')
  }
  requireString(errors, rawPlan, 'sourceOwnerScopeRef')

  const compiler = rawPlan['compiler']
  if (!isRecord(compiler)) {
    addError(errors, 'compiler', 'must be an object')
  } else {
    unknownFieldErrors(errors, compiler, COMPILER_KEYS, 'compiler')
    if (compiler['name'] !== 'spaces-config/resources') {
      addError(errors, 'compiler.name', 'must be spaces-config/resources')
    }
    if (compiler['version'] !== 1) {
      addError(errors, 'compiler.version', 'must be 1')
    }
  }

  const resources = rawPlan['resources']
  if (!Array.isArray(resources)) {
    addError(errors, 'resources', 'must be an array')
  } else {
    resources.forEach((resource, index) => {
      const prefix = `resources[${index}]`
      if (!isRecord(resource)) {
        addError(errors, prefix, 'must be an object')
        return
      }
      unknownFieldErrors(errors, resource, RESOURCE_KEYS, prefix)
      const kind = resource['resourceKind']
      if (typeof kind !== 'string' || !RESOURCE_KINDS.has(kind)) {
        addError(
          errors,
          `${prefix}.resourceKind`,
          'must be scheduled-job, event-hook, or interface-binding'
        )
      }
      const expectedTable = kind === 'interface-binding' ? 'interface_bindings' : 'jobs'
      if (RESOURCE_KINDS.has(String(kind)) && resource['projectionTable'] !== expectedTable) {
        addError(errors, `${prefix}.projectionTable`, `must be ${expectedTable}`)
      }
      for (const field of [
        'projectionId',
        'projectionPk',
        'sourceOwnerScopeRef',
        'resourceName',
        'sourcePath',
      ]) {
        requireString(errors, resource, field, `${prefix}.${field}`)
      }
      if (resource['sourceHash'] === undefined || !HASH_RE.test(String(resource['sourceHash']))) {
        addError(errors, `${prefix}.sourceHash`, 'must be a canonical sha256 hash')
      }
      if (
        resource['desiredProjectionHash'] === undefined ||
        !HASH_RE.test(String(resource['desiredProjectionHash']))
      ) {
        addError(errors, `${prefix}.desiredProjectionHash`, 'must be a canonical sha256 hash')
      }
      if (!isRecord(resource['desiredJson'])) {
        addError(errors, `${prefix}.desiredJson`, 'must be an object')
      }
      if (resource['sourceVersion'] !== 1) {
        addError(errors, `${prefix}.sourceVersion`, 'must be 1')
      }
      if (resource['managedBy'] !== 'agent-directory') {
        addError(errors, `${prefix}.managedBy`, 'must be agent-directory')
      }
      if (resource['origin'] !== 'created') {
        addError(errors, `${prefix}.origin`, 'must be created')
      }
      for (const field of ['lastReconciledAt', 'createdAt', 'updatedAt']) {
        if (resource[field] !== 'pending-apply') {
          addError(errors, `${prefix}.${field}`, 'must be pending-apply')
        }
      }
      validateOriginPolicy(errors, resource, index)
      validateDesiredOutput(errors, resource, index)
    })
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
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
        ...liveIdFromResult(result),
        error: errorFromResult(result),
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
    evictCachedStore('jobs', input.jobsDbPath)
    evictCachedStore('iface', input.interfaceDbPath)
    if (activeMemoryApplyInput === input) {
      activeMemoryApplyInput = undefined
    }
  }
  return result
}

export async function statusWithStores(
  input: GetManagedResourcesStatusWithStoresInput
): Promise<GetManagedResourcesStatusResult> {
  const jobResources: ManagedResourceStatusEntry[] = listManagedJobProvenances(input.jobsStore, {
    ownerScopeRef: input.ownerScopeRef,
  }).map((provenance) => {
    const drift = detectJobDrift(input.jobsStore, provenance.projectionId)
    const job = input.jobsStore.getJob(provenance.jobId).job
    return {
      projectionId: provenance.projectionId,
      resourceKind: provenance.resourceKind,
      projectionPk: provenance.projectionPk,
      state: provenance.state,
      disabled: job === undefined ? provenance.state === 'disabled' : job.disabled,
      ...(job === undefined ? {} : jobOperationalFacts(job)),
      ...driftFacts(drift),
    }
  })
  const bindingResources: ManagedResourceStatusEntry[] = listManagedBindingProvenances(
    input.interfaceStore,
    { ownerScopeRef: input.ownerScopeRef }
  ).map((provenance) => {
    const drift = detectBindingDrift(input.interfaceStore, provenance.projectionId)
    const binding = input.interfaceStore.bindings.getById(provenance.bindingId)
    return {
      projectionId: provenance.projectionId,
      resourceKind: provenance.resourceKind,
      projectionPk: provenance.projectionPk,
      state: provenance.state,
      disabled:
        binding === undefined ? provenance.state === 'disabled' : binding.status === 'disabled',
      ...(binding === undefined ? {} : bindingOperationalFacts(binding)),
      ...driftFacts(drift),
    }
  })

  const resources = [...jobResources, ...bindingResources]
  if (input.projectionIds === undefined) {
    return { resources }
  }
  const byProjectionId = new Map(resources.map((resource) => [resource.projectionId, resource]))
  return {
    resources: input.projectionIds.flatMap((projectionId) => {
      const resource = byProjectionId.get(projectionId)
      return resource === undefined ? [] : [resource]
    }),
  }
}

export async function getManagedResourcesStatus(
  input: GetManagedResourcesStatusInput
): Promise<GetManagedResourcesStatusResult> {
  return statusWithStores({
    ownerScopeRef: input.ownerScopeRef,
    projectionIds: input.projectionIds,
    jobsStore: openCachedJobsStore(input.jobsDbPath),
    interfaceStore: openCachedInterfaceStore(input.interfaceDbPath),
  })
}
