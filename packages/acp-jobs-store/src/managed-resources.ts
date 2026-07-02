import { createHash, randomUUID } from 'node:crypto'

import { validateJobTrigger } from 'acp-core'

import {
  type JobFlowValidationError,
  formatJobFlowValidationErrors,
  validateJobFlowJob,
} from './flow-validation.js'
import type { CreateJobInput, JobRecord, JobsStore, UpdateJobInput } from './open-store.js'

// ---------------------------------------------------------------------------
// Types (API contract frozen by Phase C RED tests)
// ---------------------------------------------------------------------------

export type ResourceKindJob = 'scheduled-job' | 'event-hook'

export type ManagedJobProvenanceRecord = {
  provenanceId: string
  projectionId: string
  projectionPk: string
  jobId: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  resourceKind: ResourceKindJob
  managedBy: 'agent-directory'
  sourceVersion: number
  state: 'active' | 'disabled'
  appliedAt: string
  createdAt: string
  updatedAt: string
}

export type ApplyManagedJobInput = {
  projectionId: string
  projectionPk: string
  sourceOwnerScopeRef: string
  resourceName: string
  sourcePath: string
  sourceHash: string
  desiredProjectionHash: string
  desiredJson: Record<string, unknown>
  resourceKind: ResourceKindJob
  now: string
}

type CollisionError = {
  code: 'UNMANAGED_COLLISION' | 'FOREIGN_MANAGED_COLLISION'
  existingSlug?: string | undefined
  existingJobId?: string | undefined
}

type StaleAdoptionError = {
  code: 'STALE_ADOPTION'
  projectionId: string
  existingPk?: string | undefined
  incomingPk?: string | undefined
}

type ValidationError = {
  code: string
  message: string
  errors?: JobFlowValidationError[] | undefined
}

export type ApplyManagedJobResult =
  | { outcome: 'created'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'updated'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'noop'; job: JobRecord; provenance: ManagedJobProvenanceRecord }
  | { outcome: 'collision'; error: CollisionError }
  | { outcome: 'stale_adoption_rejected'; error: StaleAdoptionError }
  | { outcome: 'validation_error'; error: ValidationError }

export type DriftReport = {
  hasDrift: boolean
  driftKind?: 'shape' | 'hash' | 'both' | undefined
  currentHash?: string | undefined
  desiredHash?: string | undefined
}

type ProvenanceJobRow = {
  provenance_id: string
  projection_id: string
  projection_pk: string
  job_id: string
  source_owner_scope_ref: string
  resource_name: string
  source_path: string
  source_hash: string
  desired_projection_hash: string
  desired_projection_json: string
  resource_kind: ResourceKindJob
  managed_by: 'agent-directory'
  source_version: number
  state: 'active' | 'disabled'
  applied_at: string
  created_at: string
  updated_at: string
}

function newProvenanceId(): string {
  return `mjob_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  if (!isRecord(value)) {
    return JSON.stringify(value)
  }
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function internalHash(value: unknown): string {
  return `sha256-internal/v1:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function rowToProvenance(row: ProvenanceJobRow): ManagedJobProvenanceRecord {
  return {
    provenanceId: row.provenance_id,
    projectionId: row.projection_id,
    projectionPk: row.projection_pk,
    jobId: row.job_id,
    sourceOwnerScopeRef: row.source_owner_scope_ref,
    resourceName: row.resource_name,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    desiredProjectionHash: row.desired_projection_hash,
    resourceKind: row.resource_kind,
    managedBy: row.managed_by,
    sourceVersion: row.source_version,
    state: row.state,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function getProvenanceRow(store: JobsStore, projectionId: string): ProvenanceJobRow | undefined {
  return store.sqlite
    .prepare('SELECT * FROM managed_resource_provenance_jobs WHERE projection_id = ?')
    .get(projectionId) as ProvenanceJobRow | undefined
}

function getProvenanceByJobId(store: JobsStore, jobId: string): ProvenanceJobRow | undefined {
  return store.sqlite
    .prepare('SELECT * FROM managed_resource_provenance_jobs WHERE job_id = ?')
    .get(jobId) as ProvenanceJobRow | undefined
}

function findJobBySlug(store: JobsStore, slug: string): JobRecord | undefined {
  const row = store.sqlite
    .prepare('SELECT job_id FROM jobs WHERE slug = ? AND archived_at IS NULL LIMIT 1')
    .get(slug) as { job_id: string } | undefined
  return row === undefined ? undefined : store.getJob(row.job_id).job
}

function getString(record: Record<string, unknown>, key: string, fallback?: string): string {
  const value = record[key]
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new Error(`desiredJson.${key} must be a non-empty string`)
}

function getOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function getBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key]
  return typeof value === 'boolean' ? value : fallback
}

function getRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) {
    throw new Error(`desiredJson.${key} must be an object`)
  }
  return value
}

function validateManagedEventTrigger(
  trigger: Record<string, unknown>
): ValidationError | undefined {
  if (!('cooldown' in trigger)) {
    return {
      code: 'MISSING_COOLDOWN',
      message: 'event-hook trigger.cooldown must be materialized as a canonical duration string',
    }
  }
  if (typeof trigger['cooldown'] !== 'string') {
    return {
      code: 'MALFORMED_COOLDOWN',
      message: 'event-hook trigger.cooldown must be a duration string',
    }
  }

  const originPolicy = trigger['originPolicy']
  if (isRecord(originPolicy) && originPolicy['agent'] === 'allow') {
    return {
      code: 'ORIGIN_ALLOW_REJECTED',
      message: "event-hook originPolicy.agent='allow' is rejected in v1",
    }
  }

  const validation = validateManagedJobTrigger(trigger)
  if (!validation.valid) {
    return {
      code: 'INVALID_COOLDOWN',
      message: validation.errors.join('; '),
    }
  }
  return undefined
}

function isIsoSecondsCooldown(value: unknown): value is string {
  return typeof value === 'string' && /^PT([1-9][0-9]*)S$/.test(value)
}

function validateManagedJobTrigger(
  value: Record<string, unknown>
): ReturnType<typeof validateJobTrigger> {
  const validation = validateJobTrigger(value)
  if (validation.valid) {
    return validation
  }

  const cooldown = value['cooldown']
  const match = isIsoSecondsCooldown(cooldown) ? /^PT([1-9][0-9]*)S$/.exec(cooldown) : null
  if (match === null) {
    return validation
  }
  const normalized = { ...value, cooldown: `${match[1]}s` }
  const normalizedValidation = validateJobTrigger(normalized)
  if (!normalizedValidation.valid || normalizedValidation.trigger.kind !== 'event') {
    return validation
  }

  return {
    valid: true,
    trigger: normalizedValidation.trigger,
  }
}

function invalidFlowError(errors: JobFlowValidationError[]): ValidationError {
  return {
    code: 'INVALID_FLOW',
    message: `invalid job flow: ${formatJobFlowValidationErrors(errors)}`,
    errors,
  }
}

function desiredToJobInput(input: ApplyManagedJobInput): CreateJobInput | ValidationError {
  const desired = input.desiredJson
  const slug = getString(desired, 'slug', input.projectionPk)
  const projectId = getString(desired, 'projectId')
  const agentId = getString(desired, 'agentId')
  const scopeRef = getString(desired, 'scopeRef')
  const laneRef = getOptionalString(desired, 'laneRef')
  const description = getOptionalString(desired, 'title')
  const disabled = getBoolean(desired, 'disabled', false)
  const triggerRecord = getRecord(desired, 'trigger')
  const inputTemplate = getRecord(desired, 'input')
  const output = isRecord(desired['output'])
    ? (desired['output'] as CreateJobInput['output'])
    : undefined
  const flow = isRecord(desired['flow']) ? (desired['flow'] as CreateJobInput['flow']) : undefined

  if (input.resourceKind === 'event-hook') {
    const validationError = validateManagedEventTrigger(triggerRecord)
    if (validationError !== undefined) {
      return validationError
    }
    const validation = validateManagedJobTrigger(triggerRecord)
    if (!validation.valid || validation.trigger.kind !== 'event') {
      return {
        code: 'INVALID_EVENT_TRIGGER',
        message: validation.valid
          ? 'event-hook trigger.kind must be event'
          : validation.errors.join('; '),
      }
    }
    if (flow !== undefined) {
      const flowValidation = validateJobFlowJob({
        triggerKind: validation.trigger.kind,
        flow,
      })
      if (!flowValidation.valid) {
        return invalidFlowError(flowValidation.errors)
      }
    }
    return {
      slug,
      projectId,
      agentId,
      scopeRef,
      ...(laneRef !== undefined ? { laneRef } : {}),
      ...(description !== undefined ? { description } : {}),
      trigger: validation.trigger,
      input: inputTemplate,
      ...(output !== undefined ? { output } : {}),
      ...(flow !== undefined ? { flow } : {}),
      disabled,
      actor: { kind: 'system', id: 'managed-resources' },
      actorStamp: 'system:managed-resources',
      createdAt: input.now,
    }
  }

  const schedule = getRecord(desired, 'schedule')
  if (flow !== undefined) {
    const flowValidation = validateJobFlowJob({
      triggerKind: 'schedule',
      schedule: schedule as CreateJobInput['schedule'],
      flow,
    })
    if (!flowValidation.valid) {
      return invalidFlowError(flowValidation.errors)
    }
  }
  return {
    slug,
    projectId,
    agentId,
    scopeRef,
    ...(laneRef !== undefined ? { laneRef } : {}),
    ...(description !== undefined ? { description } : {}),
    schedule: schedule as CreateJobInput['schedule'],
    input: inputTemplate,
    ...(output !== undefined ? { output } : {}),
    ...(flow !== undefined ? { flow } : {}),
    disabled,
    actor: { kind: 'system', id: 'managed-resources' },
    actorStamp: 'system:managed-resources',
    createdAt: input.now,
  }
}

function jobInputToPatch(jobInput: CreateJobInput): UpdateJobInput {
  return {
    slug: jobInput.slug,
    description: jobInput.description,
    trigger: jobInput.trigger,
    schedule: jobInput.schedule,
    input: jobInput.input,
    output: jobInput.output,
    flow: jobInput.flow,
    disabled: jobInput.disabled,
    actor: jobInput.actor,
    actorStamp: jobInput.actorStamp,
  }
}

function liveProjectionFromJob(
  job: JobRecord,
  desiredJson: Record<string, unknown>
): Record<string, unknown> {
  const live: Record<string, unknown> = { ...desiredJson }
  live['slug'] = job.slug
  live['projectId'] = job.projectId
  live['agentId'] = job.agentId
  live['scopeRef'] = job.scopeRef
  live['laneRef'] = job.laneRef
  live['disabled'] = job.disabled
  live['input'] = job.input
  if (job.output !== undefined) {
    live['output'] = job.output
  } else {
    live['output'] = undefined
  }
  if (job.flow !== undefined) {
    live['flow'] = job.flow
  } else {
    live['flow'] = undefined
  }
  live['title'] = job.description

  if (job.trigger.kind === 'event') {
    const desiredTrigger = isRecord(desiredJson['trigger']) ? desiredJson['trigger'] : {}
    live['trigger'] = { ...desiredTrigger, ...job.trigger }
  } else {
    live['trigger'] = { kind: 'schedule' }
    live['schedule'] = job.schedule
  }
  return live
}

function insertProvenance(
  store: JobsStore,
  input: ApplyManagedJobInput,
  job: JobRecord
): ManagedJobProvenanceRecord {
  const desiredJson = stableJson(input.desiredJson)
  const rowFingerprint = internalHash(liveProjectionFromJob(job, input.desiredJson))
  const provenanceId = newProvenanceId()
  store.sqlite
    .prepare(
      `INSERT INTO managed_resource_provenance_jobs (
         provenance_id,
         projection_id,
         projection_pk,
         projection_row_fingerprint,
         projection_row_updated_at,
         job_id,
         source_owner_scope_ref,
         resource_name,
         source_path,
         source_hash,
         desired_projection_hash,
         desired_projection_json,
         resource_kind,
         managed_by,
         source_version,
         state,
         applied_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent-directory', 1, 'active', ?, ?, ?)`
    )
    .run(
      provenanceId,
      input.projectionId,
      input.projectionPk,
      rowFingerprint,
      job.updatedAt,
      job.jobId,
      input.sourceOwnerScopeRef,
      input.resourceName,
      input.sourcePath,
      input.sourceHash,
      input.desiredProjectionHash,
      desiredJson,
      input.resourceKind,
      input.now,
      input.now,
      input.now
    )

  return rowToProvenance(getProvenanceRow(store, input.projectionId) as ProvenanceJobRow)
}

function updateProvenance(
  store: JobsStore,
  input: ApplyManagedJobInput,
  existing: ManagedJobProvenanceRecord,
  job: JobRecord
): ManagedJobProvenanceRecord {
  const desiredJson = stableJson(input.desiredJson)
  const rowFingerprint = internalHash(liveProjectionFromJob(job, input.desiredJson))
  store.sqlite
    .prepare(
      `UPDATE managed_resource_provenance_jobs
          SET projection_row_fingerprint = ?,
              projection_row_updated_at = ?,
              source_hash = ?,
              desired_projection_hash = ?,
              desired_projection_json = ?,
              state = 'active',
              source_version = ?,
              applied_at = ?,
              updated_at = ?
        WHERE projection_id = ?`
    )
    .run(
      rowFingerprint,
      job.updatedAt,
      input.sourceHash,
      input.desiredProjectionHash,
      desiredJson,
      existing.sourceVersion + 1,
      input.now,
      input.now,
      input.projectionId
    )

  return rowToProvenance(getProvenanceRow(store, input.projectionId) as ProvenanceJobRow)
}

function collisionForJob(
  store: JobsStore,
  projectionId: string,
  job: JobRecord
): ApplyManagedJobResult | undefined {
  const owner = getProvenanceByJobId(store, job.jobId)
  if (owner === undefined) {
    return {
      outcome: 'collision',
      error: {
        code: 'UNMANAGED_COLLISION',
        existingSlug: job.slug,
        existingJobId: job.jobId,
      },
    }
  }
  if (owner.projection_id !== projectionId) {
    return {
      outcome: 'collision',
      error: {
        code: 'FOREIGN_MANAGED_COLLISION',
        existingSlug: job.slug,
        existingJobId: job.jobId,
      },
    }
  }
  return undefined
}

export function applyManagedJob(
  store: JobsStore,
  input: ApplyManagedJobInput
): ApplyManagedJobResult {
  let jobInput: CreateJobInput
  try {
    const converted = desiredToJobInput(input)
    if ('code' in converted) {
      return { outcome: 'validation_error', error: converted }
    }
    jobInput = converted
  } catch (error) {
    return {
      outcome: 'validation_error',
      error: {
        code: 'INVALID_PROJECTION',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  return store.runInTransaction(() => {
    const existingRow = getProvenanceRow(store, input.projectionId)
    const existing = existingRow === undefined ? undefined : rowToProvenance(existingRow)
    if (existing !== undefined && existing.projectionPk !== input.projectionPk) {
      return {
        outcome: 'stale_adoption_rejected',
        error: {
          code: 'STALE_ADOPTION',
          projectionId: input.projectionId,
          existingPk: existing.projectionPk,
          incomingPk: input.projectionPk,
        },
      } satisfies ApplyManagedJobResult
    }

    const targetSlug = jobInput.slug ?? input.projectionPk
    const jobAtSlug = findJobBySlug(store, targetSlug)
    if (existing === undefined && jobAtSlug !== undefined) {
      const collision = collisionForJob(store, input.projectionId, jobAtSlug)
      if (collision !== undefined) {
        return collision
      }
    }

    if (existing !== undefined) {
      const existingJob = store.getJob(existing.jobId).job
      if (existingJob === undefined) {
        return {
          outcome: 'collision',
          error: { code: 'UNMANAGED_COLLISION', existingJobId: existing.jobId },
        } satisfies ApplyManagedJobResult
      }
      if (jobAtSlug !== undefined && jobAtSlug.jobId !== existing.jobId) {
        const collision = collisionForJob(store, input.projectionId, jobAtSlug)
        if (collision !== undefined) {
          return collision
        }
      }

      const liveProjection = liveProjectionFromJob(existingJob, input.desiredJson)
      const desiredJson = stableJson(input.desiredJson)
      const liveMatchesDesired = stableJson(liveProjection) === desiredJson
      if (
        existing.sourceHash === input.sourceHash &&
        existing.desiredProjectionHash === input.desiredProjectionHash &&
        existing.state === 'active' &&
        liveMatchesDesired
      ) {
        return { outcome: 'noop', job: existingJob, provenance: existing }
      }

      const job = store.updateJob(existing.jobId, jobInputToPatch(jobInput)).job
      const provenance = updateProvenance(store, input, existing, job)
      return { outcome: 'updated', job, provenance }
    }

    const job = store.createJob(jobInput).job
    const provenance = insertProvenance(store, input, job)
    return { outcome: 'created', job, provenance }
  })
}

export function getManagedJobProvenance(
  store: JobsStore,
  projectionId: string
): ManagedJobProvenanceRecord | undefined {
  const row = getProvenanceRow(store, projectionId)
  return row === undefined ? undefined : rowToProvenance(row)
}

export function listManagedJobProvenances(
  store: JobsStore,
  filter?: { ownerScopeRef?: string | undefined } | undefined
): ManagedJobProvenanceRecord[] {
  const rows =
    filter?.ownerScopeRef === undefined
      ? (store.sqlite
          .prepare('SELECT * FROM managed_resource_provenance_jobs ORDER BY created_at ASC')
          .all() as ProvenanceJobRow[])
      : (store.sqlite
          .prepare(
            `SELECT *
               FROM managed_resource_provenance_jobs
              WHERE source_owner_scope_ref = ?
              ORDER BY created_at ASC`
          )
          .all(filter.ownerScopeRef) as ProvenanceJobRow[])
  return rows.map(rowToProvenance)
}

export function detectJobDrift(store: JobsStore, projectionId: string): DriftReport {
  const row = getProvenanceRow(store, projectionId)
  if (row === undefined) {
    return { hasDrift: false }
  }

  const job = store.getJob(row.job_id).job
  if (job === undefined) {
    return {
      hasDrift: true,
      driftKind: 'both',
      desiredHash: row.desired_projection_hash,
    }
  }

  const desiredJson = JSON.parse(row.desired_projection_json) as Record<string, unknown>
  const currentProjection = liveProjectionFromJob(job, desiredJson)
  const currentShape = stableJson(currentProjection)
  const desiredShape = stableJson(desiredJson)
  if (currentShape === desiredShape) {
    return { hasDrift: false }
  }

  return {
    hasDrift: true,
    driftKind: 'shape',
    currentHash: internalHash(currentProjection),
    desiredHash: row.desired_projection_hash,
  }
}

export function disableManagedJob(
  store: JobsStore,
  projectionId: string,
  _reason: 'source_missing'
): { job: JobRecord; provenance: ManagedJobProvenanceRecord } {
  return store.runInTransaction(() => {
    const provenance = getManagedJobProvenance(store, projectionId)
    if (provenance === undefined) {
      throw new Error(`managed job provenance not found: ${projectionId}`)
    }

    const job = store.updateJob(provenance.jobId, {
      disabled: true,
      actor: { kind: 'system', id: 'managed-resources' },
      actorStamp: 'system:managed-resources',
    }).job
    const now = new Date().toISOString()
    store.sqlite
      .prepare(
        `UPDATE managed_resource_provenance_jobs
            SET state = 'disabled',
                projection_row_fingerprint = ?,
                projection_row_updated_at = ?,
                updated_at = ?
          WHERE projection_id = ?`
      )
      .run(
        internalHash(
          liveProjectionFromJob(
            job,
            JSON.parse(
              getProvenanceRow(store, projectionId)?.desired_projection_json ?? '{}'
            ) as Record<string, unknown>
          )
        ),
        job.updatedAt,
        now,
        projectionId
      )

    const updated = getManagedJobProvenance(store, projectionId)
    if (updated === undefined) {
      throw new Error(`managed job provenance not found after disable: ${projectionId}`)
    }
    return { job, provenance: updated }
  })
}
