import { validateJobOutputConfig } from '../jobs/job-output-config.js'
import { isRecord } from '../parsers/body.js'

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

export type PlanValidationResult =
  | { valid: true }
  | { valid: false; errors: Array<{ field: string; message: string }> }
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

function validateDesiredExecution(
  errors: Array<{ field: string; message: string }>,
  resource: Record<string, unknown>,
  index: number
): void {
  const desiredJson = resource['desiredJson']
  if (!isRecord(desiredJson) || desiredJson['execution'] === undefined) {
    return
  }
  const prefix = `resources[${index}].desiredJson.execution`

  const kind = resource['resourceKind']
  const message =
    kind === 'event-hook'
      ? 'is unsupported for event-hook resources in v1'
      : 'is only supported for scheduled-job resources'
  addError(errors, prefix, message)
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

  const planOwnerScopeRef = rawPlan['sourceOwnerScopeRef']
  const seenProjectionIds = new Set<string>()
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
      // T-05244: the plan owner is the authority boundary. A caller must not be
      // able to smuggle an arbitrary per-resource owner past validation, status,
      // or reconcile authorization scoping.
      if (
        typeof resource['sourceOwnerScopeRef'] === 'string' &&
        typeof planOwnerScopeRef === 'string' &&
        resource['sourceOwnerScopeRef'] !== planOwnerScopeRef
      ) {
        addError(errors, `${prefix}.sourceOwnerScopeRef`, 'must equal plan.sourceOwnerScopeRef')
      }
      // T-05244: source deletion is projection-id based, so one plan must not
      // carry ambiguous duplicate identities.
      if (typeof resource['projectionId'] === 'string') {
        if (seenProjectionIds.has(resource['projectionId'])) {
          addError(errors, `${prefix}.projectionId`, 'duplicate projectionId in plan')
        } else {
          seenProjectionIds.add(resource['projectionId'])
        }
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
      if (resource['resourceKind'] !== 'scheduled-job') {
        validateOriginPolicy(errors, resource, index)
        validateDesiredOutput(errors, resource, index)
        validateDesiredExecution(errors, resource, index)
      }
    })
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}
