import { badRequest, json } from '../http.js'
import { isRecord, parseJsonBody } from '../parsers/body.js'
import {
  type ManagedResourcesPlan,
  type SourceDeletionPolicy,
  applyPlanWithStores,
  reconcilePlanWithStores,
  statusWithStores,
  validateManagedResourcesPlan,
} from '../resources/apply.js'
import type { RouteHandler } from '../routing/route-context.js'

const SOURCE_DELETION_POLICIES: ReadonlySet<string> = new Set(['disable', 'archive', 'purge'])

function parseSourceDeletionPolicy(body: Record<string, unknown>): SourceDeletionPolicy {
  const value = body['sourceDeletionPolicy']
  if (value === undefined) {
    return 'disable'
  }
  if (typeof value !== 'string' || !SOURCE_DELETION_POLICIES.has(value)) {
    badRequest('sourceDeletionPolicy must be one of disable, archive, purge', {
      field: 'sourceDeletionPolicy',
    })
  }
  return value as SourceDeletionPolicy
}

function requireJobsStore(deps: Parameters<RouteHandler>[0]['deps']) {
  if (deps.jobsStore === undefined) {
    throw new Error('jobs store is not configured')
  }
  return deps.jobsStore
}

function parseApplyBody(body: unknown): { plan: unknown } {
  if (!isRecord(body)) {
    badRequest('request body must be a JSON object')
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'plan')) {
    badRequest('plan is required', { field: 'plan' })
  }
  return { plan: body['plan'] }
}

function parseStatusBody(body: unknown): {
  ownerScopeRef: string
  projectionIds?: string[] | undefined
} {
  if (!isRecord(body)) {
    badRequest('request body must be a JSON object')
  }
  const ownerScopeRef = body['ownerScopeRef']
  if (typeof ownerScopeRef !== 'string' || ownerScopeRef.trim().length === 0) {
    badRequest('ownerScopeRef must be a non-empty string', { field: 'ownerScopeRef' })
  }
  const projectionIds = body['projectionIds']
  if (projectionIds === undefined) {
    return { ownerScopeRef: ownerScopeRef.trim() }
  }
  if (
    !Array.isArray(projectionIds) ||
    projectionIds.some(
      (projectionId) => typeof projectionId !== 'string' || projectionId.trim() === ''
    )
  ) {
    badRequest('projectionIds must be an array of non-empty strings', { field: 'projectionIds' })
  }
  return {
    ownerScopeRef: ownerScopeRef.trim(),
    projectionIds: projectionIds.map((projectionId) => projectionId.trim()),
  }
}

export const handleApplyManagedResources: RouteHandler = async ({ request, deps }) => {
  const body = parseApplyBody(await parseJsonBody(request))
  const validation = validateManagedResourcesPlan(body.plan)
  if (!validation.valid) {
    badRequest('managed resources plan is invalid', { errors: validation.errors })
  }
  const plan = body.plan as ManagedResourcesPlan

  const result = await applyPlanWithStores({
    plan,
    jobsStore: requireJobsStore(deps),
    interfaceStore: deps.interfaceStore,
    now: new Date().toISOString(),
  })
  return json(result)
}

export const handleGetManagedResourcesStatus: RouteHandler = async ({ request, deps }) => {
  const rawBody = await parseJsonBody(request)
  if (!isRecord(rawBody)) {
    badRequest('request body must be a JSON object')
  }
  const hasPlan = Object.prototype.hasOwnProperty.call(rawBody, 'plan')
  const hasOwner = Object.prototype.hasOwnProperty.call(rawBody, 'ownerScopeRef')
  if (hasPlan && hasOwner) {
    badRequest('provide either plan or ownerScopeRef, not both')
  }

  if (hasPlan) {
    const validation = validateManagedResourcesPlan(rawBody['plan'])
    if (!validation.valid) {
      badRequest('managed resources plan is invalid', { errors: validation.errors })
    }
    const plan = rawBody['plan'] as ManagedResourcesPlan
    const sourceDeletionPolicy = parseSourceDeletionPolicy(rawBody)
    const result = await statusWithStores({
      plan,
      sourceDeletionPolicy,
      jobsStore: requireJobsStore(deps),
      interfaceStore: deps.interfaceStore,
    })
    return json(result)
  }

  const body = parseStatusBody(rawBody)
  const result = await statusWithStores({
    ownerScopeRef: body.ownerScopeRef,
    projectionIds: body.projectionIds,
    jobsStore: requireJobsStore(deps),
    interfaceStore: deps.interfaceStore,
  })
  return json(result)
}

export const handleReconcileManagedResources: RouteHandler = async ({ request, deps }) => {
  const rawBody = await parseJsonBody(request)
  if (!isRecord(rawBody)) {
    badRequest('request body must be a JSON object')
  }
  if (!Object.prototype.hasOwnProperty.call(rawBody, 'plan')) {
    badRequest('plan is required', { field: 'plan' })
  }
  const validation = validateManagedResourcesPlan(rawBody['plan'])
  if (!validation.valid) {
    badRequest('managed resources plan is invalid', { errors: validation.errors })
  }
  const plan = rawBody['plan'] as ManagedResourcesPlan
  const sourceDeletionPolicy = parseSourceDeletionPolicy(rawBody)

  const result = await reconcilePlanWithStores({
    plan,
    jobsStore: requireJobsStore(deps),
    interfaceStore: deps.interfaceStore,
    now: new Date().toISOString(),
    sourceDeletionPolicy,
  })
  return json(result)
}
