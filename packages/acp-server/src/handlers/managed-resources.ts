import { badRequest, json } from '../http.js'
import { isRecord, parseJsonBody } from '../parsers/body.js'
import {
  type ManagedResourcesPlan,
  applyPlanWithStores,
  statusWithStores,
  validateManagedResourcesPlan,
} from '../resources/apply.js'
import type { RouteHandler } from '../routing/route-context.js'

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

function parseStatusBody(body: unknown): { ownerScopeRef: string } {
  if (!isRecord(body)) {
    badRequest('request body must be a JSON object')
  }
  const ownerScopeRef = body['ownerScopeRef']
  if (typeof ownerScopeRef !== 'string' || ownerScopeRef.trim().length === 0) {
    badRequest('ownerScopeRef must be a non-empty string', { field: 'ownerScopeRef' })
  }
  return { ownerScopeRef: ownerScopeRef.trim() }
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
  const body = parseStatusBody(await parseJsonBody(request))
  const result = await statusWithStores({
    ownerScopeRef: body.ownerScopeRef,
    jobsStore: requireJobsStore(deps),
    interfaceStore: deps.interfaceStore,
  })
  return json(result)
}
